import type { CoreSessionConfig } from "@plinycode/core"
import { isPlinySelfHostedModelId, PLINY_BALANCE_AUTO_MODEL_ID, PLINY_FREE_AUTO_MODEL_ID } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { getSessionState, isModelHealthy, resetHealth, resetSessions } from "./router-health"
import { installRouter, type RouterInstallDeps } from "./router-integration"
import { REVIEW_NUDGE_PREFIX } from "./router-review"
import type { RouterRunLogRecord } from "./router-run-log"

vi.mock("./router-rules-store", async () => {
	const { defaultRules } = await import("./router-rules")
	return { loadRouterRules: vi.fn(async (options?: { profile?: string }) => defaultRules(options?.profile)) }
})

const NOW = 1_700_000_000_000
const KIMI = "snps-provider/kimi-k2.6"
const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const QWEN_397 = "snps-provider/qwen3.5-397b-fp8"
const NEMOTRON_ULTRA = "snps-provider/nemotron-3-ultra-550b-a55"
/** The utility model: classifier at the start of a turn, completion judge at its end. */
const UTILITY = "snps-provider/qwen3-6-35b-a3b-1-28dd3"
const STOP: AgentModelEvent = { type: "finish", reason: "stop" }
const ONE_ISSUE = '{"issues":[{"file":"src/stats.ts","line":2,"problem":"sort() compares as strings.","why":"No comparator."}]}'
const CODE = "export function median(values) {\n\tconst sorted = values.sort()\n\treturn sorted[0]\n}\n"

function scripted(events: AgentModelEvent[]): AgentModel {
	return {
		async *stream() {
			for (const event of events) {
				yield event
			}
		},
	}
}

function request(text: string): AgentModelRequest {
	return { messages: [{ id: "m1", role: "user", content: [{ type: "text", text }], createdAt: 0 }], tools: [] }
}

function user(text: string): AgentMessage {
	return { id: "u", role: "user", content: [{ type: "text", text }], createdAt: 0 }
}

function assistant(text: string): AgentMessage {
	return { id: "a", role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

/** The editor call that wrote `src/stats.ts`, and its result. */
function editRound(): AgentMessage[] {
	return [
		{
			id: "e1",
			role: "assistant",
			content: [
				{ type: "tool-call", toolCallId: "c1", toolName: "editor", input: { path: "src/stats.ts", new_text: CODE } },
			],
			createdAt: 0,
		},
		{
			id: "e2",
			role: "tool",
			content: [
				{
					type: "tool-result",
					toolCallId: "c1",
					toolName: "editor",
					output: { query: "edit:src/stats.ts", result: "", success: true },
				},
			],
			createdAt: 0,
		},
	]
}

function setup(modelId: string = PLINY_FREE_AUTO_MODEL_ID, extra: Partial<RouterInstallDeps> = {}) {
	const rows: string[] = []
	const runs: RouterRunLogRecord[] = []
	/** Models asked once the run is about to end, in order: the judge, then the reviewer. */
	const askedAtEnd: string[] = []
	const reviewer = vi.fn((_modelId: string) => scripted([{ type: "text-delta", text: ONE_ISSUE }, STOP]))
	const classifier = vi.fn(() => scripted([{ type: "text-delta", text: '{"tier":"code","think":false}' }, STOP]))
	const judge = vi.fn(() =>
		scripted([{ type: "text-delta", text: '{"done": true, "reason": "The function was added."}' }, STOP]),
	)
	let working = true
	let ts = 0
	const config = installRouter({ providerId: "pliny", modelId, cwd: "/repo" } as unknown as CoreSessionConfig, {
		sessionId: "s",
		getMode: () => "act",
		emitRow: (message) => rows.push(message.text ?? ""),
		nextMessageTs: () => ++ts,
		logCall: () => undefined,
		logRun: (record) => runs.push(record),
		now: () => NOW,
		...extra,
	})

	/** Start a run and make its first model call, so the turn has an author. */
	const run = async (agentConfig: { parentAgentId?: string } = {}, prompt = "fix the failing test") => {
		working = true
		const model = config.agentModelFactory?.({
			config: { modelId, ...agentConfig } as never,
			createDefault: (overrides) => {
				const id = overrides?.modelId ?? "(default)"
				if (working) {
					return id === UTILITY ? classifier() : scripted([{ type: "text-delta", text: "ok" }, STOP])
				}
				askedAtEnd.push(id)
				return id === UTILITY ? judge() : reviewer(id)
			},
		})
		if (!model) {
			throw new Error("router did not install a model factory")
		}
		for await (const _event of await model.stream(request(prompt))) {
			// drain
		}
		// From here on, a model is built only for the judge or for a review.
		working = false
		askedAtEnd.length = 0
	}

	const afterEdit = (parentAgentId?: string) =>
		config.hooks?.afterTool?.({
			snapshot: { agentId: "a", iteration: 1, ...(parentAgentId ? { parentAgentId } : {}) } as never,
			tool: { name: "editor" } as never,
			toolCall: { type: "tool-call", toolCallId: "c1", toolName: "editor", input: {} },
			input: {},
			result: { output: { query: "edit:src/stats.ts", result: "", success: true } },
			startedAt: new Date(NOW),
			endedAt: new Date(NOW),
			durationMs: 0,
		})

	/** The run is about to end on `reply`, after the model edited `src/stats.ts`. */
	const finish = (reply = "I added median().", iteration = 2) => {
		const message = assistant(reply)
		const runMessages = [...editRound(), message]
		return config.completionGuard?.({ message, iteration, runMessages, messages: [user("Add median()"), ...runMessages] })
	}

	const endRun = (parentAgentId?: string) =>
		config.hooks?.afterRun?.({
			snapshot: { agentId: "a", iteration: 2, ...(parentAgentId ? { parentAgentId } : {}) } as never,
			result: {
				agentId: "a",
				runId: "r1",
				status: "completed",
				iterations: 2,
				outputText: "Done.",
				messages: [assistant("Done.")],
				usage: {} as never,
			},
		})

	return { config, rows, runs, askedAtEnd, reviewer, classifier, judge, run, afterEdit, finish, endRun }
}

describe("installRouter reviewer pass", () => {
	beforeEach(() => {
		resetHealth()
		resetSessions()
	})

	it("reviews a routed run that changed files with another model, tells the chat and logs it", async () => {
		const { rows, runs, askedAtEnd, run, afterEdit, finish, endRun } = setup()
		await run()
		expect(getSessionState("s").calls[0]?.modelId).toBe(KIMI)
		await afterEdit()
		rows.length = 0

		const nudge = await finish()
		expect(nudge).toContain(REVIEW_NUDGE_PREFIX)
		expect(nudge).toContain("1. src/stats.ts:2: sort() compares as strings.")
		// The judge is satisfied first. kimi wrote the code, so the reviewer is
		// the next model of the reasoning route.
		expect(askedAtEnd).toEqual([UTILITY, QWEN_397])
		expect(rows).toHaveLength(2)
		expect(rows[0]).toContain("🔎 **qwen3.5-397b-fp8** is reviewing this turn's changes (1 file, +4 −0)")
		expect(rows[1]).toContain("🔎 **qwen3.5-397b-fp8** flagged 1 possible problem (0s) · asked the model to check it")

		await endRun()
		expect(runs[0]).toMatchObject({
			sessionId: "s",
			subAgent: false,
			judge: "done",
			review: { outcome: "issues", model: QWEN_397, issues: 1, durationMs: 0, source: "tool-calls", files: 1 },
		})
	})

	it("waits for the judge: a run it calls unfinished is not reviewed yet", async () => {
		const { judge, reviewer, run, afterEdit, finish } = setup()
		judge.mockReturnValueOnce(
			scripted([{ type: "text-delta", text: '{"done": false, "reason": "report() was not updated."}' }, STOP]),
		)
		await run()
		await afterEdit()
		expect(await finish("median() is ready.", 2)).toContain("suggests the task is not finished")
		expect(reviewer).not.toHaveBeenCalled()
		// The model finishes the work; now the run would end, and the review runs.
		expect(await finish("I added median() and updated report().", 4)).toContain(REVIEW_NUDGE_PREFIX)
		expect(reviewer).toHaveBeenCalledTimes(1)
	})

	it("says so when the reviewer finds nothing, and lets the run end", async () => {
		const { rows, runs, reviewer, run, afterEdit, finish, endRun } = setup()
		reviewer.mockReturnValue(scripted([{ type: "text-delta", text: '{"issues": []}' }, STOP]))
		await run()
		await afterEdit()
		expect(await finish()).toBeUndefined()
		expect(rows.at(-1)).toContain("🔎 **qwen3.5-397b-fp8** found no problems (0s)")
		await endRun()
		expect(runs[0]?.review).toMatchObject({ outcome: "clean", issues: 0, model: QWEN_397 })
	})

	it("leaves a run that changed nothing alone", async () => {
		const { rows, runs, reviewer, run, config, endRun } = setup()
		await run()
		rows.length = 0
		const reply = assistant("median() lives in src/stats.ts.")
		expect(
			await config.completionGuard?.({ message: reply, iteration: 1, runMessages: [reply], messages: [reply] }),
		).toBeUndefined()
		expect(reviewer).not.toHaveBeenCalled()
		expect(rows).toEqual([])
		await endRun()
		expect(runs[0]?.review).toEqual({ outcome: "skipped", reason: "no-changes" })
	})

	it("uses the run's checkpoint diff when the host provides one", async () => {
		const getRunChanges = vi.fn(async () => ({
			cwd: "/repo",
			diffs: [{ filePath: "/repo/src/stats.ts", leftContent: "a\nb\nc\n", rightContent: "a\nB\nC\nd\n" }],
		}))
		const { rows, runs, run, afterEdit, finish, endRun } = setup(PLINY_FREE_AUTO_MODEL_ID, { getRunChanges })
		await run()
		await afterEdit()
		expect(await finish()).toContain(REVIEW_NUDGE_PREFIX)
		expect(getRunChanges).toHaveBeenCalledTimes(1)
		expect(rows.some((row) => row.includes("(1 file, +3 −2)"))).toBe(true)
		await endRun()
		expect(runs[0]?.review).toMatchObject({ source: "checkpoint" })
	})

	it("keeps its reminder out of the completion guard's counters", async () => {
		const { rows, run, afterEdit, finish } = setup()
		await run()
		await afterEdit()
		const state = getSessionState("s")
		expect(await finish("I added median().", 2)).toContain(REVIEW_NUDGE_PREFIX)
		expect(state.run.nudges).toBe(0)
		expect(state.run.guardRules).toEqual([])

		// A stall right after the review reminder is the guard's first, not an
		// escalated second: the guard never saw the review as one of its own.
		rows.length = 0
		const stalled = await finish("Let me fix the sort:", 3)
		expect(stalled).toContain("did not call a tool")
		expect(stalled).not.toContain("Second reminder")
		expect(rows[0]).toContain("(rule: announcement, 1/8)")
		expect(state.run.escalated).toBeUndefined()
		expect(state.run.review).toMatchObject({ outcome: "issues" })
	})

	it("is not held back by reminders the guard already spent", async () => {
		const { run, afterEdit, finish, config } = setup()
		await run()
		await afterEdit()
		const state = getSessionState("s")
		// Two stalls the model acted on: the guard's budget is partly used.
		const stall = { message: assistant("Let me check the log:"), iteration: 1 }
		expect(await config.completionGuard?.(stall)).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(await config.completionGuard?.({ ...stall, iteration: 3 })).toContain("did not call a tool")
		state.run.toolCalls += 1
		expect(state.run.nudges).toBe(2)

		expect(await finish("I added median().", 5)).toContain(REVIEW_NUDGE_PREFIX)
		expect(state.run.nudges).toBe(2)
	})

	it("does not review a reply the guard gave up on", async () => {
		const { run, afterEdit, finish, reviewer, runs, endRun } = setup()
		await run()
		await afterEdit()
		expect(await finish("Let me fix the sort:", 1)).toContain("did not call a tool")
		expect(await finish("Let me fix the sort:", 2)).toContain("Second reminder")
		// The third stall in a row ends the run unfinished; a review of half the work would not help.
		expect(await finish("Let me fix the sort:", 3)).toBeUndefined()
		expect(reviewer).not.toHaveBeenCalled()
		await endRun()
		expect(runs[0]).toMatchObject({ guardGaveUp: "repeated-stall", review: { outcome: "skipped", reason: "guard-gave-up" } })
	})

	it("stays off when the setting is off, and in plan mode", async () => {
		const off = setup(PLINY_FREE_AUTO_MODEL_ID, { reviewEnabled: () => false })
		await off.run()
		await off.afterEdit()
		expect(await off.finish()).toBeUndefined()
		expect(off.reviewer).not.toHaveBeenCalled()
		await off.endRun()
		expect(off.runs[0]?.review).toEqual({ outcome: "skipped", reason: "setting-off" })

		const plan = setup(PLINY_FREE_AUTO_MODEL_ID, { getMode: () => "plan" })
		await plan.run()
		await plan.afterEdit()
		expect(await plan.finish()).toBeUndefined()
		expect(plan.reviewer).not.toHaveBeenCalled()
		await plan.endRun()
		expect(plan.runs[0]?.review).toEqual({ outcome: "skipped", reason: "not-act-mode" })
	})

	it("never reviews a sub-agent's run, but counts its edits for the root's review", async () => {
		const getRunChanges = vi.fn(async () => ({
			cwd: "/repo",
			diffs: [{ filePath: "/repo/src/stats.ts", leftContent: "", rightContent: CODE }],
		}))
		const { runs, askedAtEnd, run, afterEdit, endRun, config } = setup(PLINY_FREE_AUTO_MODEL_ID, { getRunChanges })
		await run()
		await run({ parentAgentId: "root-agent" })
		await afterEdit("root-agent")
		await endRun("root-agent")
		expect(runs[0]).toMatchObject({ subAgent: true, review: { outcome: "skipped", reason: "sub-agent" } })

		// The root transcript shows no edit, only the sub-agent's report.
		const reply = assistant("The sub-agent added median().")
		const nudge = await config.completionGuard?.({ message: reply, iteration: 2, runMessages: [reply], messages: [reply] })
		expect(nudge).toContain(REVIEW_NUDGE_PREFIX)
		// Both runs were kimi's, so the reviewer is still someone else.
		expect(askedAtEnd).toEqual([QWEN_397])
	})

	it("does not apply to a concrete model", async () => {
		const { run, afterEdit, finish, reviewer, runs, endRun } = setup(KIMI)
		await run()
		await afterEdit()
		expect(await finish()).toBeUndefined()
		expect(reviewer).not.toHaveBeenCalled()
		await endRun()
		expect(runs).toEqual([])
	})

	it("on BalanceAuto, reviews both a free and a paid model's work, always with a free reviewer", async () => {
		const { askedAtEnd, classifier, reviewer, runs, run, afterEdit, finish, endRun } = setup(PLINY_BALANCE_AUTO_MODEL_ID)
		// The coding route leads with kimi; the reasoning route is all paid, so the free pool reviews.
		await run()
		expect(getSessionState("s").calls[0]?.modelId).toBe(KIMI)
		await afterEdit()
		expect(await finish()).toContain(REVIEW_NUDGE_PREFIX)
		expect(askedAtEnd).toEqual([UTILITY, CODER])

		// A turn that paid Claude answers: its fix-up round is billed, which BalanceAuto allows.
		classifier.mockReturnValueOnce(scripted([{ type: "text-delta", text: '{"tier":"reason","think":true}' }, STOP]))
		await run()
		const author = "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking"
		expect(getSessionState("s").calls[0]?.modelId).toBe(author)
		await afterEdit()
		reviewer.mockClear()
		askedAtEnd.length = 0
		expect(await finish()).toContain(REVIEW_NUDGE_PREFIX)
		expect(reviewer).toHaveBeenCalledTimes(1)
		const reviewedBy = askedAtEnd.at(-1) ?? ""
		expect(isPlinySelfHostedModelId(reviewedBy)).toBe(true)
		expect(reviewedBy).not.toBe(author)
		await endRun()
		expect(runs[0]?.review).toMatchObject({ outcome: "issues", model: reviewedBy })
	})

	it("counts a reviewer that cannot be reached against its health, and asks the next one afterwards", async () => {
		const { rows, runs, askedAtEnd, reviewer, run, afterEdit, finish, endRun } = setup()
		reviewer.mockImplementation(() => scripted([{ type: "finish", reason: "error", error: "503 upstream unavailable" }]))
		for (let turn = 0; turn < 2; turn += 1) {
			await run()
			await afterEdit()
			expect(await finish()).toBeUndefined()
			expect(askedAtEnd).toEqual([UTILITY, QWEN_397])
		}
		expect(rows.at(-1)).toContain("The review by **qwen3.5-397b-fp8** gave no result (_503 upstream unavailable_)")
		await endRun()
		expect(runs[0]?.review).toMatchObject({ outcome: "no-verdict", reason: "503 upstream unavailable", model: QWEN_397 })
		expect(isModelHealthy(QWEN_397, NOW)).toBe(false)

		await run()
		await afterEdit()
		await finish()
		expect(askedAtEnd).toEqual([UTILITY, NEMOTRON_ULTRA])
	})
})
