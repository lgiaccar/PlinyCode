import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentModel, AgentModelEvent, AgentModelRequest } from "@plinycode/shared"
import { estimateRequestInputTokens } from "@plinycode/shared"
import { createHash } from "crypto"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { installSessionTrace, pruneSessionTraces, type SessionTraceDeps } from "./session-trace"

const NOW = 1_700_000_000_000
const STOP: AgentModelEvent = { type: "finish", reason: "stop" }
// What the trace writes in place of a secret.
const REDACTED = "[REDACTED]"
// Fixture secrets, shaped so the pre-commit secret scan does not take them for real ones.
const FAKE_KEY = "aaaaaaaaaaaaaaaaaaaa"
const FAKE_BEARER = "abcdefghijklmnop"

function scripted(events: AgentModelEvent[]): AgentModel {
	return {
		async *stream() {
			for (const event of events) {
				yield event
			}
		},
	}
}

function request(text = "fix the failing test", extra: Partial<AgentModelRequest> = {}): AgentModelRequest {
	return {
		systemPrompt: "You are PlinyCode.",
		messages: [{ id: "m1", role: "user", content: [{ type: "text", text }], createdAt: 0 }],
		tools: [{ name: "read_files", description: "Read files", inputSchema: { type: "object" } }],
		signal: new AbortController().signal,
		...extra,
	}
}

let dir: string

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-trace-"))
})

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true })
})

async function readTrace(sessionId: string): Promise<Array<Record<string, unknown>>> {
	const text = await fs.readFile(path.join(dir, `${sessionId}.jsonl`), "utf8")
	return text
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
}

function setup(model: AgentModel, overrides: Partial<SessionTraceDeps> = {}, hooks: CoreSessionConfig["hooks"] = undefined) {
	let clock = NOW
	const config = { sessionId: "s1", hooks } as unknown as CoreSessionConfig
	const trace = installSessionTrace(config, { enabled: () => true, dir, now: () => (clock += 10), ...overrides })
	const factory = config.agentModelFactory
	if (!factory) {
		throw new Error("no factory installed")
	}
	const send = async (req: AgentModelRequest = request(), agentId = "agent-1") => {
		const wrapped = factory({ config: { modelId: "pliny/auto-free" } as never, createDefault: () => model, agentId })
		const events: AgentModelEvent[] = []
		for await (const event of await wrapped.stream(req)) {
			events.push(event)
		}
		return events
	}
	return { config, trace, send }
}

describe("installSessionTrace", () => {
	it("writes one request and one stream line per call, redacted and truncated", async () => {
		const longText = "x".repeat(5_000)
		const model = scripted([
			{ type: "text-delta", text: "hello" },
			{ type: "reasoning-delta", text: "hmm" },
			{ type: "tool-call-delta", toolCallId: "c1", toolName: "read_files", input: {} },
			{
				type: "usage",
				usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, modelId: "snps/qwen", totalCost: 0 },
			},
			{ type: "finish", reason: "tool-calls" },
		])
		const { trace, send } = setup(model)
		const events = await send(
			request(`please use apiKey: sk-abcdefghijklmnopqrstuvwxyz and ${longText}`, {
				messages: [
					{
						id: "m1",
						role: "user",
						content: [{ type: "text", text: `token=supersecretvalue ${longText}` }],
						createdAt: 0,
					},
					{
						id: "m2",
						role: "assistant",
						content: [
							{
								type: "tool-call",
								toolCallId: "c0",
								toolName: "fetch",
								input: { url: "https://x", apiKey: FAKE_KEY },
							},
						],
						createdAt: 1,
					},
				],
			}),
		)
		expect(events).toHaveLength(5)
		await trace.flush()

		const lines = await readTrace("s1")
		expect(lines.map((line) => line.type)).toEqual(["request", "stream"])

		const req = lines[0]
		expect(req).toMatchObject({
			sessionId: "s1",
			agentId: "agent-1",
			modelId: "pliny/auto-free",
			systemPromptSha256: createHash("sha256").update("You are PlinyCode.").digest("hex"),
			systemPromptChars: "You are PlinyCode.".length,
			messageCount: 2,
			tools: ["read_files"],
		})
		expect(req).not.toHaveProperty("systemPrompt")
		expect(req).not.toHaveProperty("signal")
		const messages = req.messages as Array<{ content: Array<Record<string, unknown>> }>
		const text = messages[0].content[0].text as string
		expect(text.startsWith(`token=${REDACTED}`)).toBe(true)
		expect(text.length).toBeLessThan(4_100)
		expect(text).toMatch(/\[\+\d+ chars\]$/)
		expect(messages[1].content[0].input).toEqual({ url: "https://x", apiKey: REDACTED })
		expect(req.ts).toBe(new Date(NOW + 10).toISOString())

		expect(lines[1]).toMatchObject({
			type: "stream",
			modelId: "pliny/auto-free",
			routedModelId: "snps/qwen",
			finishReason: "tool-calls",
			textChars: 5,
			reasoningChars: 3,
			toolCalls: 1,
			usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cost: 0 },
		})
		expect(lines[1].ttftMs).toBeGreaterThan(0)
		expect(lines[1].durationMs).toBeGreaterThanOrEqual(lines[1].ttftMs as number)
	})

	it("writes only the messages added since the agent's previous request", async () => {
		const { trace, send } = setup(scripted([STOP]))
		const first = request("one")
		await send(first)
		const second = {
			...first,
			messages: [
				...first.messages,
				{ id: "m2", role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], createdAt: 1 },
				{ id: "m3", role: "user" as const, content: [{ type: "text" as const, text: "two" }], createdAt: 2 },
			],
		}
		await send(second)
		await trace.flush()

		const requests = (await readTrace("s1")).filter((line) => line.type === "request")
		expect(requests[0]).toMatchObject({ messageCount: 1, fromIndex: 0, newMessages: 1 })
		expect(requests[0]).not.toHaveProperty("reset")
		expect(requests[1]).toMatchObject({ messageCount: 3, fromIndex: 1, newMessages: 2 })
		expect(requests[1]).not.toHaveProperty("reset")
		expect((requests[1].messages as Array<{ id: string }>).map((message) => message.id)).toEqual(["m2", "m3"])
		expect(requests[1].totalChars).toBe(JSON.stringify(second.messages).length)
		// The estimate compaction compares with its trigger, next to the
		// provider's count on the stream record.
		expect(requests[1].estimatedTokens).toBe(
			estimateRequestInputTokens({ systemPrompt: second.systemPrompt, messages: second.messages, tools: second.tools }),
		)
	})

	it("keeps writing incrementally when the request messages carry the engine's ids", async () => {
		// The engine rebuilds the request on every call; as long as the ids it
		// assigns stay on the messages, the second record is incremental and
		// not a reset. Every record was a reset while the request build dropped
		// the ids and the engine regenerated them per call.
		const { trace, send } = setup(scripted([STOP]))
		const base = request("one")
		await send(base)
		await send({
			...base,
			messages: [
				...base.messages.map((message) => ({ ...message })),
				{ id: "m2", role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }], createdAt: 1 },
			],
		})
		await trace.flush()
		const requests = (await readTrace("s1")).filter((line) => line.type === "request")
		expect(requests.map((line) => [line.fromIndex, line.newMessages, line.reset ?? false])).toEqual([
			[0, 1, false],
			[1, 1, false],
		])
	})

	it("writes the whole list again, marked reset, when the earlier part changed", async () => {
		const { trace, send } = setup(scripted([STOP]))
		const first = request("one")
		await send({
			...first,
			messages: [
				...first.messages,
				{ id: "m2", role: "assistant", content: [{ type: "text", text: "ok" }], createdAt: 1 },
				{ id: "m3", role: "user", content: [{ type: "text", text: "two" }], createdAt: 2 },
			],
		})
		// Compaction: the list is shorter than what was written.
		await send({
			...first,
			messages: [{ id: "summary", role: "user", content: [{ type: "text", text: "summary of the above" }], createdAt: 3 }],
		})
		// Restart from an earlier message: same length as written, another id at the position.
		await send({
			...first,
			messages: [{ id: "edited", role: "user", content: [{ type: "text", text: "one, edited" }], createdAt: 4 }],
		})
		// Growth after a reset is incremental again.
		await send({
			...first,
			messages: [
				{ id: "edited", role: "user", content: [{ type: "text", text: "one, edited" }], createdAt: 4 },
				{ id: "m5", role: "assistant", content: [{ type: "text", text: "sure" }], createdAt: 5 },
			],
		})
		await trace.flush()

		const requests = (await readTrace("s1")).filter((line) => line.type === "request")
		expect(requests.map((line) => [line.fromIndex, line.newMessages, line.reset ?? false])).toEqual([
			[0, 3, false],
			[0, 1, true],
			[0, 1, true],
			[1, 1, false],
		])
		expect((requests[1].messages as Array<{ id: string }>)[0].id).toBe("summary")
		expect((requests[3].messages as Array<{ id: string }>)[0].id).toBe("m5")
	})

	it("keeps a position per agent, so a sub-agent's requests start from zero", async () => {
		const { trace, send } = setup(scripted([STOP]))
		await send(request("root one"), "root-agent")
		await send(request("sub one"), "sub-agent")
		await send(
			{
				...request("root one"),
				messages: [
					...request("root one").messages,
					{ id: "m2", role: "assistant", content: [{ type: "text", text: "spawned" }], createdAt: 1 },
				],
			},
			"root-agent",
		)
		await trace.flush()

		const requests = (await readTrace("s1")).filter((line) => line.type === "request")
		expect(requests.map((line) => [line.agentId, line.fromIndex, line.newMessages])).toEqual([
			["root-agent", 0, 1],
			["sub-agent", 0, 1],
			["root-agent", 1, 1],
		])
		expect(requests[1]).not.toHaveProperty("reset")
	})

	it("writes nothing while the setting is off", async () => {
		const { trace, send } = setup(scripted([{ type: "text-delta", text: "hi" }, STOP]), { enabled: () => false })
		await send()
		await trace.flush()
		await expect(fs.readdir(dir)).resolves.toEqual([])
	})

	it("stops a session's file at the cap with one truncated line", async () => {
		const { trace, send } = setup(scripted([{ type: "text-delta", text: "hi" }, STOP]), { maxFileBytes: 1_200 })
		for (let call = 0; call < 6; call += 1) {
			await send()
		}
		await trace.flush()
		const lines = await readTrace("s1")
		const stats = await fs.stat(path.join(dir, "s1.jsonl"))
		const last = lines[lines.length - 1]
		expect(last.type).toBe("truncated")
		expect(last).toMatchObject({ sessionId: "s1", maxBytes: 1_200 })
		expect(lines.filter((line) => line.type === "truncated")).toHaveLength(1)
		expect(lines.length).toBeLessThan(12)
		// Only the final line may push the file past the cap.
		expect(stats.size - JSON.stringify(last).length - 1).toBeLessThanOrEqual(1_200)
	})

	it("records tool calls, results, run ends and router events through the hooks it wraps", async () => {
		const baseBeforeTool = vi.fn(async () => undefined)
		const baseAfterTool = vi.fn(async () => undefined)
		const baseAfterRun = vi.fn(async () => undefined)
		const { config, trace } = setup(
			scripted([STOP]),
			{},
			{
				beforeTool: baseBeforeTool,
				afterTool: baseAfterTool,
				afterRun: baseAfterRun,
			},
		)
		const snapshot = { agentId: "agent-1", runId: "run-7", iteration: 3, parentAgentId: "root" }
		const toolCall = { type: "tool-call", toolCallId: "c1", toolName: "run_commands", input: {} }
		await config.hooks?.beforeTool?.({
			snapshot,
			tool: {},
			toolCall,
			input: { command: `curl -H 'Authorization: Bearer ${FAKE_BEARER}' https://x`, password: "hunter2" },
		} as never)
		await config.hooks?.afterTool?.({
			snapshot,
			tool: {},
			toolCall,
			input: {},
			result: { output: "y".repeat(3_000), isError: true },
			startedAt: new Date(0),
			endedAt: new Date(0),
			durationMs: 42,
		} as never)
		trace.recordRouterEvent({
			kind: "start",
			profile: "free",
			subAgent: false,
			modelId: "snps/qwen",
			route: "code",
			candidates: ["a"],
		})
		await config.hooks?.afterRun?.({
			snapshot,
			result: { status: "failed", iterations: 3, error: new Error("boom"), usage: {} },
		} as never)
		await config.hooks?.afterRun?.({
			snapshot: { ...snapshot, runId: "run-8" },
			result: { status: "completed", iterations: 1, usage: { inputTokens: 5, outputTokens: 1 } },
		} as never)
		await trace.flush()

		expect(baseBeforeTool).toHaveBeenCalledTimes(1)
		expect(baseAfterTool).toHaveBeenCalledTimes(1)
		expect(baseAfterRun).toHaveBeenCalledTimes(2)
		const lines = await readTrace("s1")
		expect(lines.map((line) => line.type)).toEqual(["tool_call", "tool_result", "router", "error", "run_end"])
		expect(lines[0]).toMatchObject({
			agentId: "agent-1",
			parentAgentId: "root",
			runId: "run-7",
			iteration: 3,
			tool: "run_commands",
			toolCallId: "c1",
			input: { command: `curl -H 'Authorization: Bearer ${REDACTED}' https://x`, password: REDACTED },
		})
		expect(lines[1]).toMatchObject({ tool: "run_commands", durationMs: 42, ok: false })
		expect((lines[1].output as string).length).toBeLessThan(2_100)
		expect(lines[2]).toMatchObject({ kind: "start", modelId: "snps/qwen", route: "code", candidates: ["a"], runId: "run-7" })
		expect(lines[3]).toMatchObject({ status: "failed", iterations: 3, error: "boom" })
		expect(lines[4]).toMatchObject({
			status: "completed",
			iterations: 1,
			runId: "run-8",
			usage: { inputTokens: 5, outputTokens: 1 },
		})
	})

	it("records compaction notices with their diagnostics through onEvent, and nothing for other notices", async () => {
		const baseOnEvent = vi.fn(async () => undefined)
		const { config, trace } = setup(scripted([STOP]), {}, { onEvent: baseOnEvent })
		const snapshot = { agentId: "agent-1", runId: "run-7", iteration: 12 }
		await config.hooks?.onEvent?.({
			type: "status-notice",
			snapshot,
			message: "auto-compacted",
			metadata: {
				kind: "auto_compaction",
				reason: "auto_compaction",
				phase: "completed",
				iteration: 12,
				diagnostics: {
					mode: "auto",
					phase: "completed",
					strategy: "agentic",
					before: { messages: 41, estimatedTokens: 160_200, chars: 480_000 },
					after: { messages: 9, estimatedTokens: 46_100, chars: 138_000 },
					overheadTokens: 22_000,
					budget: { triggerTokens: 148_400 },
					factors: { underestimateFactor: 0.85, budgetScale: 0.91 },
					summary: { chars: 9_800, sections: 2 },
					summarizer: { modelId: "nemotron-super", durationMs: 6_200 },
					durationMs: 6_400,
				},
			},
		} as never)
		await config.hooks?.onEvent?.({
			type: "status-notice",
			snapshot,
			message: "something else",
			metadata: { kind: "recovery_notice" },
		} as never)
		await config.hooks?.onEvent?.({ type: "run-started", snapshot } as never)
		await trace.flush()

		expect(baseOnEvent).toHaveBeenCalledTimes(3)
		const lines = await readTrace("s1")
		expect(lines.map((line) => line.type)).toEqual(["compaction"])
		expect(lines[0]).toMatchObject({
			agentId: "agent-1",
			runId: "run-7",
			iteration: 12,
			kind: "auto_compaction",
			phase: "completed",
			notice: "auto-compacted",
			mode: "auto",
			strategy: "agentic",
			before: { messages: 41, estimatedTokens: 160_200 },
			after: { messages: 9, estimatedTokens: 46_100 },
			budget: { triggerTokens: 148_400 },
			factors: { underestimateFactor: 0.85, budgetScale: 0.91 },
			summarizer: { modelId: "nemotron-super", durationMs: 6_200 },
		})
	})

	it("records a stream that throws and lets the error through", async () => {
		const failing: AgentModel = {
			async *stream() {
				yield { type: "text-delta", text: "partial" }
				throw new Error("connection reset")
			},
		}
		const { trace, send } = setup(failing)
		await expect(send()).rejects.toThrow("connection reset")
		await trace.flush()
		const lines = await readTrace("s1")
		expect(lines[1]).toMatchObject({ type: "stream", error: "connection reset", textChars: 7 })
		expect(lines[1]).not.toHaveProperty("finishReason")
	})

	it("reads the session id when the call is made, not when the trace is installed", async () => {
		const config = {} as CoreSessionConfig
		const trace = installSessionTrace(config, { enabled: () => true, dir })
		config.sessionId = "later"
		const wrapped = config.agentModelFactory?.({
			config: { modelId: "m" } as never,
			createDefault: () => scripted([STOP]),
		})
		for await (const _event of await (wrapped as AgentModel).stream(request())) {
			// drain
		}
		await trace.flush()
		await expect(fs.readdir(dir)).resolves.toEqual(["later.jsonl"])
	})
})

describe("pruneSessionTraces", () => {
	it("deletes the oldest files until the folder fits", async () => {
		const write = async (name: string, size: number, ageMs: number) => {
			const filePath = path.join(dir, name)
			await fs.writeFile(filePath, "x".repeat(size))
			const when = new Date(NOW - ageMs)
			await fs.utimes(filePath, when, when)
		}
		await write("old.jsonl", 600, 30_000)
		await write("mid.jsonl", 600, 20_000)
		await write("new.jsonl", 600, 10_000)
		await write("notes.txt", 600, 40_000)

		await pruneSessionTraces({ dir, maxTotalBytes: 1_300 })

		const left = (await fs.readdir(dir)).sort()
		expect(left).toEqual(["mid.jsonl", "new.jsonl", "notes.txt"])
	})

	it("is a no-op for a missing folder", async () => {
		await expect(pruneSessionTraces({ dir: path.join(dir, "missing") })).resolves.toBeUndefined()
	})
})
