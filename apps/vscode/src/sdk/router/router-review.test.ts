import type { AgentMessage, AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import {
	buildReviewRequest,
	createReviewPass,
	parseReviewIssues,
	pickReviewer,
	REVIEW_NUDGE_PREFIX,
	type ReviewInput,
	type ReviewPassOptions,
	type ReviewRecord,
	reviewNudge,
	runReviewer,
} from "./router-review"
import { defaultRules } from "./router-rules"

const KIMI = "snps-provider/kimi-k2.6"
const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const QWEN_397 = "snps-provider/qwen3.5-397b-fp8"
const NEMOTRON_ULTRA = "snps-provider/nemotron-3-ultra-550b-a55"
const SONNET_5 = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"

const ONE_ISSUE =
	'{"issues":[{"file":"src/stats.ts","line":12,"problem":"sort() compares as strings.","why":"No comparator is passed."}]}'

let nextId = 0

function user(text: string, metadata?: Record<string, unknown>): AgentMessage {
	return {
		id: `u${++nextId}`,
		role: "user",
		content: [{ type: "text", text }],
		createdAt: 0,
		...(metadata ? { metadata } : {}),
	}
}

function assistant(text: string): AgentMessage {
	return { id: `a${++nextId}`, role: "assistant", content: [{ type: "text", text }], createdAt: 0 }
}

function edit(path: string, newText: string, success = true): AgentMessage[] {
	const toolCallId = `c${++nextId}`
	return [
		{
			id: `a${nextId}`,
			role: "assistant",
			content: [{ type: "tool-call", toolCallId, toolName: "editor", input: { path, new_text: newText } }],
			createdAt: 0,
		},
		{
			id: `t${nextId}`,
			role: "tool",
			content: [
				{ type: "tool-result", toolCallId, toolName: "editor", output: { query: `edit:${path}`, result: "", success } },
			],
			createdAt: 0,
		},
	]
}

function replying(text: string, seen?: AgentModelRequest[]): AgentModel {
	return {
		async *stream(request) {
			seen?.push(request)
			yield { type: "text-delta", text } satisfies AgentModelEvent
			yield { type: "finish", reason: "stop" } satisfies AgentModelEvent
		},
	}
}

/** A model that never answers until its request is aborted. */
function hanging(): AgentModel {
	return {
		async *stream(request) {
			await new Promise<void>((resolve) => {
				if (request.signal?.aborted) {
					resolve()
				}
				request.signal?.addEventListener("abort", () => resolve(), { once: true })
			})
			yield { type: "finish", reason: "error", error: "aborted" } satisfies AgentModelEvent
		},
	}
}

const INPUT: ReviewInput = {
	userRequest: "Add median() to src/stats.ts",
	finalReply: "I added median().",
	diff: "=== src/stats.ts (+3 -0) ===\n@@ -1,1 +1,4 @@\n+const sorted = values.sort()",
	files: 1,
	added: 3,
	removed: 0,
}

describe("pickReviewer", () => {
	const healthy = () => true

	it("takes the reasoning route's lead model that did not write the code", () => {
		// The default profile's reasoning route is kimi, the 397B, nemotron ultra.
		expect(pickReviewer({ rules: defaultRules(), authors: new Set([KIMI]), isHealthy: healthy })).toBe(QWEN_397)
		expect(pickReviewer({ rules: defaultRules(), authors: new Set([QWEN_397]), isHealthy: healthy })).toBe(KIMI)
		expect(pickReviewer({ rules: defaultRules("fast"), authors: new Set([CODER]), isHealthy: healthy })).toBe(QWEN_397)
	})

	it("never picks a model that worked on the turn, however many did", () => {
		const authors = new Set([KIMI, QWEN_397])
		expect(pickReviewer({ rules: defaultRules(), authors, isHealthy: healthy })).toBe(NEMOTRON_ULTRA)
	})

	it("moves on to the next candidate when the lead is benched", () => {
		const isHealthy = (id: string) => id !== QWEN_397
		expect(pickReviewer({ rules: defaultRules(), authors: new Set([KIMI]), isHealthy })).toBe(NEMOTRON_ULTRA)
	})

	it("follows a rules file that reorders the reasoning route", () => {
		const rules = defaultRules()
		const route = rules.routes.find((entry) => entry.tier === "reason")
		if (!route) {
			throw new Error("default rules have no reasoning route")
		}
		route.use = [CODER, KIMI]
		expect(pickReviewer({ rules, authors: new Set([KIMI]), isHealthy: healthy })).toBe(CODER)
	})

	it("passes over paid models: BalanceAuto's reasoning route is all paid, so the free pool reviews", () => {
		const rules = defaultRules("balance")
		expect(rules.routes.find((entry) => entry.tier === "reason")?.use).toContain(SONNET_5)
		expect(pickReviewer({ rules, authors: new Set([KIMI]), isHealthy: healthy })).toBe(CODER)
		expect(pickReviewer({ rules, authors: new Set([SONNET_5]), isHealthy: healthy })).toBe(KIMI)
	})

	it("picks nobody when every free model wrote the code or is benched", () => {
		const rules = { ...defaultRules(), pool: [KIMI, CODER] }
		expect(pickReviewer({ rules, authors: new Set([KIMI, CODER]), isHealthy: healthy })).toBeUndefined()
		// A benched model is not asked, although routing itself would fall back to it.
		expect(pickReviewer({ rules, authors: new Set([KIMI]), isHealthy: () => false })).toBeUndefined()
	})
})

describe("buildReviewRequest", () => {
	it("sends the request, the final reply and the diff, tool-free, JSON-only and with reasoning off", () => {
		const built = buildReviewRequest(INPUT, new AbortController().signal)
		const prompt = (built.messages[0]?.content[0] as { text: string }).text
		expect(prompt).toContain("User's request:\nAdd median() to src/stats.ts")
		expect(prompt).toContain("The assistant's final message:\nI added median().")
		expect(prompt).toContain("What the assistant changed: 1 file, +3 -0 lines")
		expect(prompt).toContain("+const sorted = values.sort()")
		expect(prompt).not.toContain("cut to fit")
		expect(built.tools).toEqual([])
		expect(built.options).toMatchObject({ thinking: false, responseFormat: "json" })
		expect(built.systemPrompt).toContain('{"issues": [')
		expect(built.systemPrompt).toContain("At most 5 issues")
		expect(built.systemPrompt).toContain("Do not report style, naming")
	})

	it("tells the reviewer when it sees only part of the diff", () => {
		const built = buildReviewRequest({ ...INPUT, truncated: true }, new AbortController().signal)
		expect((built.messages[0]?.content[0] as { text: string }).text).toContain("the diff below is cut to fit")
	})
})

describe("parseReviewIssues", () => {
	it("reads the plain object, and an empty list as a clean review", () => {
		expect(parseReviewIssues(ONE_ISSUE)).toEqual([
			{ file: "src/stats.ts", line: 12, problem: "sort() compares as strings.", why: "No comparator is passed." },
		])
		expect(parseReviewIssues('{"issues": []}')).toEqual([])
	})

	it("reads a fenced reply, a chatty one, and one that follows a think block", () => {
		expect(parseReviewIssues(`\`\`\`json\n${ONE_ISSUE}\n\`\`\``)).toHaveLength(1)
		expect(
			parseReviewIssues(`Here is my review of the change:\n\n${ONE_ISSUE}\n\nLet me know if you need more.`),
		).toHaveLength(1)
		expect(parseReviewIssues(`<think>{"issues": "maybe"} hmm</think>${ONE_ISSUE}`)).toHaveLength(1)
	})

	it("reads a bare list from a model that dropped the wrapper", () => {
		expect(parseReviewIssues('[{"file":"a.ts","problem":"Returns NaN."},{"file":"b.ts","problem":"Never called."}]')).toEqual(
			[
				{ file: "a.ts", problem: "Returns NaN." },
				{ file: "b.ts", problem: "Never called." },
			],
		)
	})

	it("keeps at most five issues and drops entries without a problem", () => {
		const many = Array.from({ length: 8 }, (_, index) => ({ file: `f${index}.ts`, problem: `Problem ${index}.` }))
		expect(parseReviewIssues(JSON.stringify({ issues: many }))).toHaveLength(5)
		expect(parseReviewIssues('{"issues":[{"file":"a.ts"},{"problem":"  "},"text",{"problem":"Real."}]}')).toEqual([
			{ problem: "Real." },
		])
	})

	it("accepts a line given as a string and ignores one that is not a line number", () => {
		const parse = (line: string) => parseReviewIssues(`{"issues":[{"file":"a.ts","line":${line},"problem":"P."}]}`)?.[0]?.line
		expect(parse('"42"')).toBe(42)
		expect(parse("null")).toBeUndefined()
		expect(parse("0")).toBeUndefined()
		expect(parse('"near the top"')).toBeUndefined()
	})

	it("gives no answer for a reply with no usable object", () => {
		expect(parseReviewIssues("")).toBeUndefined()
		expect(parseReviewIssues("The change looks fine to me.")).toBeUndefined()
		expect(parseReviewIssues('{"verdict": "ok"}')).toBeUndefined()
		expect(parseReviewIssues('{"issues": [{"file": "a.ts", "problem": "cut off')).toBeUndefined()
	})
})

describe("runReviewer", () => {
	it("returns the issues of a usable reply", async () => {
		const result = await runReviewer({ model: replying(ONE_ISSUE), input: INPUT, timeoutMs: 1000 })
		expect(result.issues).toHaveLength(1)
		expect(result.error).toBeUndefined()
	})

	it("reports a timeout, a failed call and an unreadable reply as errors, never as issues", async () => {
		const timedOut = await runReviewer({ model: hanging(), input: INPUT, timeoutMs: 20 })
		expect(timedOut).toEqual({ error: "timed out after 20ms" })

		const failing: AgentModel = {
			async *stream() {
				yield { type: "finish", reason: "error", error: "503 upstream unavailable" } satisfies AgentModelEvent
			},
		}
		expect(await runReviewer({ model: failing, input: INPUT, timeoutMs: 1000 })).toEqual({
			error: "503 upstream unavailable",
		})

		const throwing: AgentModel = {
			stream() {
				throw new Error("socket hang up")
			},
		}
		expect((await runReviewer({ model: throwing, input: INPUT, timeoutMs: 1000 })).error).toBe("socket hang up")

		const chatty = await runReviewer({ model: replying("Looks good to me!"), input: INPUT, timeoutMs: 1000 })
		expect(chatty.issues).toBeUndefined()
		expect(chatty.error).toBe("unusable reply: Looks good to me!")
		expect(chatty.raw).toBe("Looks good to me!")
	})

	it("stops when the run is cancelled", async () => {
		const controller = new AbortController()
		const pending = runReviewer({ model: hanging(), input: INPUT, timeoutMs: 10_000, signal: controller.signal })
		controller.abort()
		expect((await pending).issues).toBeUndefined()
	})
})

describe("reviewNudge", () => {
	it("lists the findings and tells the model to check, fix and report what it dismissed", () => {
		const nudge = reviewNudge(
			[
				{ file: "src/stats.ts", line: 12, problem: "sort() compares as strings.", why: "No comparator is passed." },
				{ problem: "The empty-list case is missing." },
			],
			"qwen3.5-397b-fp8",
		)
		expect(nudge.startsWith(REVIEW_NUDGE_PREFIX)).toBe(true)
		expect(nudge.startsWith("[SYSTEM] ")).toBe(true)
		expect(nudge).toContain("another model (qwen3.5-397b-fp8)")
		expect(nudge).toContain("flagged 2 possible problems:")
		expect(nudge).toContain("1. src/stats.ts:12: sort() compares as strings. (No comparator is passed.)")
		expect(nudge).toContain("2. The empty-list case is missing.")
		expect(nudge).toContain("Check each item against the code")
		expect(nudge).toContain("Fix the ones that are real")
		expect(nudge).toContain("say in it which items you dismissed and why")
		expect(reviewNudge([{ problem: "P." }], "m")).toContain("flagged 1 possible problem:")
	})
})

describe("createReviewPass", () => {
	const CODE = "export function median(values) {\n\tconst sorted = values.sort()\n\treturn sorted[0]\n}\n"

	function harness(overrides: Partial<ReviewPassOptions> = {}, reviewerReply = ONE_ISSUE) {
		const requests: AgentModelRequest[] = []
		const asked: string[] = []
		const started: Array<{ modelId: string; files: number; added: number; removed: number }> = []
		const results: Array<{ modelId: string; record: ReviewRecord }> = []
		const reviewerErrors: string[] = []
		let recorded: ReviewRecord | undefined
		const pass = createReviewPass({
			isActive: () => true,
			isEnabled: () => true,
			getMode: () => "act",
			recorded: () => recorded,
			record: (review) => {
				recorded = review
			},
			rules: () => defaultRules(),
			isHealthy: () => true,
			authors: () => new Set([KIMI]),
			createModel: (modelId) => {
				asked.push(modelId)
				return replying(reviewerReply, requests)
			},
			onStart: (info) => started.push(info),
			onResult: ({ modelId, record }) => results.push({ modelId, record }),
			onReviewerError: (_modelId, error) => reviewerErrors.push(error),
			now: () => 1000,
			...overrides,
		})
		return { pass, requests, asked, started, results, reviewerErrors, record: () => recorded }
	}

	/** A turn in which the model wrote `src/stats.ts` and then gave its final reply. */
	function turnWithEdit(path = "src/stats.ts", text = CODE) {
		const reply = assistant("I added median().")
		const run = [...edit(path, text), reply]
		return { message: reply, iteration: 2, runMessages: run, messages: [user("Add median() to src/stats.ts"), ...run] }
	}

	it("has a different model review a run that changed files, and hands its findings back", async () => {
		const { pass, asked, requests, started, results, record } = harness()
		const nudge = await pass(turnWithEdit())

		expect(nudge).toContain(REVIEW_NUDGE_PREFIX)
		expect(nudge).toContain("1. src/stats.ts:12: sort() compares as strings.")
		// kimi wrote the code, so the next model of the reasoning route reads it.
		expect(asked).toEqual([QWEN_397])
		expect(nudge).toContain("another model (qwen3.5-397b-fp8)")
		const prompt = (requests[0]?.messages[0]?.content[0] as { text: string }).text
		expect(prompt).toContain("User's request:\nAdd median() to src/stats.ts")
		expect(prompt).toContain("+\tconst sorted = values.sort()")
		expect(started).toEqual([{ modelId: QWEN_397, files: 1, added: 4, removed: 0 }])
		expect(results).toHaveLength(1)
		expect(record()).toEqual({ outcome: "issues", issues: 1, model: QWEN_397, durationMs: 0, source: "tool-calls", files: 1 })
	})

	it("lets a clean review end the run", async () => {
		const { pass, record, results } = harness({}, '{"issues": []}')
		expect(await pass(turnWithEdit())).toBeUndefined()
		expect(record()).toMatchObject({ outcome: "clean", issues: 0, model: QWEN_397 })
		expect(results).toHaveLength(1)
	})

	it("does not review a run that changed no files", async () => {
		const { pass, asked, record } = harness()
		const reply = assistant("The function is in src/stats.ts.")
		const failedEdit = [...edit("src/stats.ts", CODE, false), reply]
		expect(
			await pass({ message: reply, iteration: 1, runMessages: [reply], messages: [user("where is median?"), reply] }),
		).toBeUndefined()
		expect(
			await pass({ message: reply, iteration: 2, runMessages: failedEdit, messages: [user("add it"), ...failedEdit] }),
		).toBeUndefined()
		expect(asked).toEqual([])
		expect(record()).toEqual({ outcome: "skipped", reason: "no-changes" })
	})

	it("reviews once per turn: the reply after the fix-up is not reviewed again", async () => {
		const { pass, asked, record } = harness()
		const first = turnWithEdit()
		const nudge = await pass(first)
		expect(nudge).toBeDefined()

		// The run goes on: the reminder is in the transcript, the model fixes and replies.
		const fixUp = [user(nudge ?? "", { displayRole: "system", userRunSpan: 0 }), ...edit("src/stats.ts", `${CODE}// fixed\n`)]
		const finalReply = assistant("Fixed the sort; nothing dismissed.")
		const runMessages = [...first.runMessages, ...fixUp, finalReply]
		const second = {
			message: finalReply,
			iteration: 4,
			runMessages,
			messages: [first.messages[0] as AgentMessage, ...runMessages],
		}
		expect(await pass(second)).toBeUndefined()
		expect(asked).toHaveLength(1)
		// The log keeps what the review found, not the later skip.
		expect(record()).toMatchObject({ outcome: "issues", issues: 1 })

		// A recovered run starts with a fresh run record; the transcript still says the turn was reviewed.
		const recovered = harness()
		expect(await recovered.pass({ ...second, runMessages: [finalReply] })).toBeUndefined()
		expect(recovered.asked).toEqual([])
		expect(recovered.record()).toEqual({ outcome: "skipped", reason: "already-reviewed" })
	})

	it("reviews the next turn again", async () => {
		const { pass, asked } = harness()
		const first = turnWithEdit()
		const nudge = await pass(first)
		const earlier = [...first.messages, user(nudge ?? "", { displayRole: "system", userRunSpan: 0 }), assistant("Fixed.")]
		const next = turnWithEdit("src/report.ts")
		// A new turn has a new run record.
		const second = harness()
		expect(await second.pass({ ...next, messages: [...earlier, ...next.messages] })).toContain(REVIEW_NUDGE_PREFIX)
		expect(asked).toHaveLength(1)
		expect(second.asked).toHaveLength(1)
	})

	it.each([
		["the setting is off", { isEnabled: () => false }, "setting-off"],
		["plan or ask mode", { getMode: () => "plan" as const }, "not-act-mode"],
		["a paid model would do the fix-up outside BalanceAuto", { fixRoundAllowed: () => false }, "paid-model"],
		["the guard gave up on a stalled reply", { guardGaveUp: () => true }, "guard-gave-up"],
		[
			"no other free model is available",
			{ authors: () => new Set([KIMI]), isHealthy: (id: string) => id === KIMI },
			"no-reviewer",
		],
		["no gateway model can be built yet", { createModel: () => undefined }, "no-reviewer"],
	])("skips when %s", async (_name, overrides, reason) => {
		const { pass, requests, started, record } = harness(overrides)
		expect(await pass(turnWithEdit())).toBeUndefined()
		expect(requests).toEqual([])
		expect(started).toEqual([])
		expect(record()).toEqual({ outcome: "skipped", reason })
	})

	it("does nothing at all for a run it does not apply to", async () => {
		const { pass, asked, record } = harness({ isActive: () => false })
		expect(await pass(turnWithEdit())).toBeUndefined()
		expect(asked).toEqual([])
		expect(record()).toBeUndefined()
	})

	it("skips a change under three lines and a change to documentation only", async () => {
		const small = harness()
		expect(await small.pass(turnWithEdit("src/stats.ts", "const a = 1\nconst b = 2"))).toBeUndefined()
		expect(small.record()).toEqual({ outcome: "skipped", reason: "small-change" })

		const docs = harness()
		expect(await docs.pass(turnWithEdit("docs/guide.md", CODE))).toBeUndefined()
		expect(docs.record()).toEqual({ outcome: "skipped", reason: "docs-only" })
		expect(small.requests).toEqual([])
		expect(docs.requests).toEqual([])
	})

	it("prefers the checkpoint's diff, which also shows what a sub-agent changed", async () => {
		const loadCheckpointDiff = vi.fn(async () => ({
			cwd: "/repo",
			diffs: [{ filePath: "/repo/src/other.ts", leftContent: "a\nb\nc\n", rightContent: "a\nB\nC\nd\n" }],
		}))
		// The root transcript holds no edit: a sub-agent did the work.
		const reply = assistant("Done.")
		const { pass, requests, record } = harness({ loadCheckpointDiff, subAgentEdits: () => 2 })
		const nudge = await pass({ message: reply, iteration: 2, runMessages: [reply], messages: [user("do it"), reply] })
		expect(nudge).toContain(REVIEW_NUDGE_PREFIX)
		const prompt = (requests[0]?.messages[0]?.content[0] as { text: string }).text
		expect(prompt).toContain("=== src/other.ts (+3 -2) ===")
		expect(prompt).toContain("@@ -1,3 +1,4 @@")
		expect(record()).toMatchObject({ source: "checkpoint", files: 1 })
	})

	it("falls back to the run's edit calls without a checkpoint, with a failing one, or with one that shows nothing", async () => {
		for (const loadCheckpointDiff of [
			async () => undefined,
			async () => {
				throw new Error("not a git repository")
			},
			async () => ({ cwd: "/repo", diffs: [] }),
		]) {
			const { pass, requests, record } = harness({ loadCheckpointDiff })
			expect(await pass(turnWithEdit())).toContain(REVIEW_NUDGE_PREFIX)
			expect((requests[0]?.messages[0]?.content[0] as { text: string }).text).toContain("@@ file written @@")
			expect(record()).toMatchObject({ source: "tool-calls" })
		}
	})

	it("caps a large diff and tells both the reviewer and the log", async () => {
		const huge = Array.from({ length: 4000 }, (_, index) => `export const value${index} = ${index}`).join("\n")
		const { pass, requests, record } = harness()
		await pass(turnWithEdit("src/big.ts", huge))
		const prompt = (requests[0]?.messages[0]?.content[0] as { text: string }).text
		expect(prompt.length).toBeLessThan(26_000)
		expect(prompt).toContain("the diff below is cut to fit")
		expect(prompt).toMatch(/\[… \d+ more lines of this file's diff are not shown\]/)
		expect(record()).toMatchObject({ truncated: true })
	})

	it("counts a reviewer that times out, fails or answers unreadably as no issues", async () => {
		const timedOut = harness({ createModel: () => hanging(), timeoutMs: 20 })
		expect(await timedOut.pass(turnWithEdit())).toBeUndefined()
		expect(timedOut.record()).toMatchObject({ outcome: "no-verdict", reason: "timed out after 20ms", model: QWEN_397 })
		expect(timedOut.results).toHaveLength(1)
		// Slow is not down: only a failed call counts against the model's health.
		expect(timedOut.reviewerErrors).toEqual([])

		const failed = harness({
			createModel: () => ({
				async *stream() {
					yield { type: "finish", reason: "error", error: "503 upstream unavailable" } satisfies AgentModelEvent
				},
			}),
		})
		expect(await failed.pass(turnWithEdit())).toBeUndefined()
		expect(failed.record()).toMatchObject({ outcome: "no-verdict", reason: "503 upstream unavailable" })
		expect(failed.reviewerErrors).toEqual(["503 upstream unavailable"])

		const unreadable = harness({}, "I could not find anything wrong.")
		expect(await unreadable.pass(turnWithEdit())).toBeUndefined()
		expect(unreadable.record()).toMatchObject({ outcome: "no-verdict" })
		expect(unreadable.record()?.reason).toContain("unusable reply")
		expect(unreadable.reviewerErrors).toEqual([])
	})

	it("gives up quietly when the run is cancelled while the reviewer reads", async () => {
		const controller = new AbortController()
		const { pass, results, reviewerErrors, record } = harness({ createModel: () => hanging() })
		const pending = pass({ ...turnWithEdit(), signal: controller.signal })
		await new Promise((resolve) => setTimeout(resolve, 5))
		controller.abort()
		expect(await pending).toBeUndefined()
		expect(record()).toMatchObject({ outcome: "skipped", reason: "cancelled" })
		expect(results).toEqual([])
		expect(reviewerErrors).toEqual([])
	})
})
