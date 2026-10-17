/**
 * The per-session trace: one JSONL file per conversation under
 * `<dataDir>/traces`, with a line for every model request and reply, every
 * tool call and result, every routing decision and every run that ends badly.
 * It is what is left of a bad run after the chat transcript: the request as
 * the agent built it (redacted, truncated), what came back and how long it
 * took, and which model the router actually used.
 *
 * Writing never blocks or fails the agent loop: records are queued and
 * appended in the background, errors are logged once and dropped, and a file
 * that reaches its size cap gets one final `truncated` line.
 */

import type { CoreSessionConfig } from "@plinycode/core"
import type { AgentMessage, AgentModelEvent, AgentModelRequest, AgentUsage } from "@plinycode/shared"
import { createHash } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "../legacy-state-reader"
import type { RouterCallEvent } from "../router/router-integration"

const TRACES_DIRNAME = "traces"
/** A session's file stops growing here; the last line says so. */
const DEFAULT_MAX_FILE_BYTES = 20 * 1024 * 1024
/** The folder is pruned, oldest files first, when it grows past this at extension start. */
const DEFAULT_MAX_FOLDER_BYTES = 200 * 1024 * 1024
/** Text parts of the request are cut here; tool arguments and results a little shorter. */
const MESSAGE_TEXT_CAP = 4_000
const TOOL_TEXT_CAP = 2_000

type Hooks = NonNullable<CoreSessionConfig["hooks"]>
type BeforeModelContext = Parameters<NonNullable<Hooks["beforeModel"]>>[0]
type BeforeToolContext = Parameters<NonNullable<Hooks["beforeTool"]>>[0]
type AfterToolContext = Parameters<NonNullable<Hooks["afterTool"]>>[0]
type AfterRunContext = Parameters<NonNullable<Hooks["afterRun"]>>[0]

export interface SessionTraceDeps {
	/** `plinycode.trace.enabled`, read for every record so a change applies at once. */
	enabled: () => boolean
	/** Folder the trace files go in; defaults to `<dataDir>/traces`. */
	dir?: string
	/** Bytes after which a session's file gets its final `truncated` line; defaults to 20 MB. */
	maxFileBytes?: number
	/** Injectable for tests. */
	now?: () => number
}

export interface SessionTrace {
	/** Records what the router did on a call attempt (route, candidate, failover, error). */
	recordRouterEvent(event: RouterCallEvent): void
	/** Resolves once every record queued so far is on disk. */
	flush(): Promise<void>
}

/** Fields every record carries. */
interface TraceRecordBase {
	ts: string
	sessionId: string
	type: string
	/** The engine's id for the agent whose run produced the record; sub-agents have their own. */
	agentId?: string
	/** Set on a sub-agent's records: the agent that spawned it. */
	parentAgentId?: string
	runId?: string
	iteration?: number
}

interface TraceUsage {
	inputTokens?: number
	outputTokens?: number
	cacheReadTokens?: number
	cacheWriteTokens?: number
	reasoningTokens?: number
	cost?: number
	estimated?: boolean
}

type TraceRecord =
	| (TraceRecordBase & {
			type: "request"
			/** The model the session runs on; for a router, the router's id. */
			modelId: string
			systemPromptSha256?: string
			systemPromptChars: number
			/** Messages in the whole request, written or not. */
			messageCount: number
			/** Characters of the whole message list as serialized, before redaction and truncation. */
			totalChars: number
			tools: string[]
			/** Index in the request of the first message written below; 0 on a full record. */
			fromIndex: number
			/** Messages written below: those after the previous record of this agent, or all of them. */
			newMessages: number
			/** Set when the whole list is written again because the earlier part changed (compaction, restart). */
			reset?: true
			messages: unknown[]
	  })
	| (TraceRecordBase & {
			type: "stream"
			modelId: string
			/** The model that served the call when a router picked one. */
			routedModelId?: string
			ttftMs?: number
			durationMs: number
			finishReason?: string
			/** Set when the stream finished with an error or threw. */
			error?: string
			usage?: TraceUsage
			textChars: number
			reasoningChars: number
			toolCalls: number
	  })
	| (TraceRecordBase & {
			type: "tool_call"
			tool: string
			toolCallId: string
			input: unknown
			/** Set when a hook skipped the call or stopped the run on it. */
			skipped?: boolean
			stopped?: boolean
	  })
	| (TraceRecordBase & {
			type: "tool_result"
			tool: string
			toolCallId: string
			durationMs: number
			ok: boolean
			output: unknown
	  })
	| (TraceRecordBase & { type: "router" } & RouterCallEvent)
	| (TraceRecordBase & { type: "error"; status: string; iterations: number; error: string })
	| (TraceRecordBase & { type: "run_end"; status: string; iterations: number; usage?: TraceUsage })
	| (TraceRecordBase & { type: "truncated"; bytes: number; maxBytes: number })

/** A record without the fields `record()` fills in; `Omit` on its own would merge the union into one shape. */
type TraceRecordBody = TraceRecord extends infer R
	? R extends TraceRecordBase
		? Omit<R, Exclude<keyof TraceRecordBase, "type">>
		: never
	: never

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Keys whose string values are secrets whatever the value looks like (compared lowercased, without `-` and `_`). */
const SECRET_KEYS = new Set([
	"apikey",
	"accesstoken",
	"refreshtoken",
	"idtoken",
	"authorization",
	"password",
	"passwd",
	"secret",
	"clientsecret",
	"privatekey",
	"token",
	"pat",
	"cookie",
	"setcookie",
	"xapikey",
	"credentials",
])

const SECRET_VALUE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
	{ pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, replacement: "$1 [REDACTED]" },
	{ pattern: /\bsk-[A-Za-z0-9_-]{16,}/g, replacement: "sk-[REDACTED]" },
	{ pattern: /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, replacement: "$1_[REDACTED]" },
	{ pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: "AKIA[REDACTED]" },
	{ pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, replacement: "[REDACTED JWT]" },
	{ pattern: /(?<=\b(?:api[_-]?key|token|password|secret)\s*[=:]\s*["']?)[^\s"'&]{6,}/gi, replacement: "[REDACTED]" },
]

function isSecretKey(key: string): boolean {
	const bare = key.toLowerCase().replace(/[-_]/g, "")
	if (SECRET_KEYS.has(bare)) {
		return true
	}
	return bare.endsWith("apikey") || bare.endsWith("secret") || bare.endsWith("password") || bare.endsWith("token")
}

function redactText(text: string): string {
	let result = text
	for (const { pattern, replacement } of SECRET_VALUE_PATTERNS) {
		result = result.replace(pattern, replacement)
	}
	return result
}

function truncate(text: string, cap: number): string {
	return text.length > cap ? `${text.slice(0, cap)} [+${text.length - cap} chars]` : text
}

/**
 * A copy of `value` fit for the trace: secret-looking keys and values
 * redacted, strings cut at `cap`, binary content replaced by its size.
 */
function compact(value: unknown, cap: number, depth = 0): unknown {
	if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
		return value
	}
	if (typeof value === "string") {
		return truncate(redactText(value), cap)
	}
	if (depth > 12) {
		return "[nested too deep]"
	}
	if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
		return `<binary ${value.byteLength} bytes>`
	}
	if (value instanceof URL) {
		return value.toString()
	}
	if (Array.isArray(value)) {
		return value.map((entry) => compact(entry, cap, depth + 1))
	}
	if (typeof value === "object") {
		const result: Record<string, unknown> = {}
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (isSecretKey(key) && (typeof entry === "string" || typeof entry === "number")) {
				result[key] = "[REDACTED]"
			} else {
				result[key] = compact(entry, cap, depth + 1)
			}
		}
		return result
	}
	return String(value)
}

function compactMessage(message: AgentMessage): unknown {
	const content = message.content.map((part) => {
		if (part.type === "image") {
			const size = typeof part.image === "string" ? `${part.image.length} chars` : "binary"
			return { type: "image", ...(part.mediaType ? { mediaType: part.mediaType } : {}), image: `<omitted ${size}>` }
		}
		if (part.type === "tool-call") {
			return { ...part, input: compact(part.input, TOOL_TEXT_CAP) }
		}
		if (part.type === "tool-result") {
			return { ...part, output: compact(part.output, MESSAGE_TEXT_CAP) }
		}
		return compact(part, MESSAGE_TEXT_CAP)
	})
	return {
		id: message.id,
		role: message.role,
		...(message.modelInfo ? { modelInfo: message.modelInfo } : {}),
		content,
	}
}

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function traceUsage(usage: Partial<AgentUsage> | undefined): TraceUsage | undefined {
	if (!usage) {
		return undefined
	}
	const result: TraceUsage = {
		...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
		...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
		...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
		...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
		...(usage.reasoningTokenCount !== undefined ? { reasoningTokens: usage.reasoningTokenCount } : {}),
		...(usage.totalCost !== undefined ? { cost: usage.totalCost } : {}),
		...(usage.estimated ? { estimated: true } : {}),
	}
	return Object.keys(result).length > 0 ? result : undefined
}

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

/** Appends one session's lines in order, in the background, up to the cap. */
class TraceFile {
	private queue: Promise<void> = Promise.resolve()
	/** Bytes in the file; measured on the first write, counted afterwards. */
	private bytes: number | undefined
	private stopped = false
	private warned = false

	constructor(
		private readonly filePath: string,
		private readonly maxBytes: number,
	) {}

	append(record: TraceRecord): void {
		if (this.stopped) {
			return
		}
		this.queue = this.queue
			.then(async () => {
				if (this.stopped) {
					return
				}
				if (this.bytes === undefined) {
					await fs.mkdir(path.dirname(this.filePath), { recursive: true })
					this.bytes = await fs.stat(this.filePath).then(
						(stats) => stats.size,
						() => 0,
					)
				}
				const line = `${JSON.stringify(record)}\n`
				const size = Buffer.byteLength(line, "utf8")
				if (this.bytes + size > this.maxBytes) {
					this.stopped = true
					const final: TraceRecord = {
						ts: record.ts,
						sessionId: record.sessionId,
						type: "truncated",
						bytes: this.bytes,
						maxBytes: this.maxBytes,
					}
					await fs.appendFile(this.filePath, `${JSON.stringify(final)}\n`, "utf8")
					return
				}
				await fs.appendFile(this.filePath, line, "utf8")
				this.bytes += size
			})
			.catch((error) => {
				if (!this.warned) {
					this.warned = true
					Logger.warn(`[trace] Could not write ${this.filePath}: ${errorText(error)}`)
				}
			})
	}

	flush(): Promise<void> {
		return this.queue
	}
}

function tracesDir(dir?: string): string {
	return dir ?? path.join(resolveDataDir(), TRACES_DIRNAME)
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

/**
 * Wraps the session's model factory and hooks so every request, reply, tool
 * call, tool result and run end is recorded. Installed after the router, so
 * the requests it sees are the ones the router passes on; the router's own
 * decisions arrive through `recordRouterEvent`.
 */
export function installSessionTrace(config: CoreSessionConfig, deps: SessionTraceDeps): SessionTrace {
	const now = deps.now ?? Date.now
	const maxBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
	const files = new Map<string, TraceFile>()
	// Where each agent's run is, from its latest hook snapshot: the factory has
	// no snapshot, so the request and stream records read it from here.
	const runs = new Map<string, { runId?: string; iteration: number; parentAgentId?: string }>()
	let latestAgentId: string | undefined
	// How much of each agent's message list the trace already holds, so a
	// request record carries only the messages added since the last one: the
	// whole list every iteration would grow a long conversation's file
	// quadratically. Checked against the id of the last message written, so a
	// list that was compacted, truncated or restarted is written in full again.
	const positions = new Map<string, { written: number; lastId?: string }>()
	const messagesToWrite = (
		key: string,
		messages: readonly AgentMessage[],
	): { fromIndex: number; messages: readonly AgentMessage[]; reset?: true } => {
		const position = positions.get(key)
		positions.set(key, { written: messages.length, lastId: messages[messages.length - 1]?.id })
		if (!position) {
			return { fromIndex: 0, messages }
		}
		const unchanged =
			messages.length >= position.written &&
			(position.written === 0 || messages[position.written - 1]?.id === position.lastId)
		if (!unchanged) {
			return { fromIndex: 0, messages, reset: true }
		}
		return { fromIndex: position.written, messages: messages.slice(position.written) }
	}

	const fileFor = (sessionId: string): TraceFile => {
		let file = files.get(sessionId)
		if (!file) {
			file = new TraceFile(path.join(tracesDir(deps.dir), `${sessionId}.jsonl`), maxBytes)
			files.set(sessionId, file)
		}
		return file
	}

	const record = (agentId: string | undefined, body: TraceRecordBody): void => {
		if (!deps.enabled()) {
			return
		}
		const sessionId = config.sessionId?.trim()
		if (!sessionId) {
			return
		}
		const id = agentId ?? latestAgentId
		const run = id ? runs.get(id) : undefined
		const line = {
			ts: new Date(now()).toISOString(),
			sessionId,
			...(id ? { agentId: id } : {}),
			...(run?.parentAgentId ? { parentAgentId: run.parentAgentId } : {}),
			...(run?.runId ? { runId: run.runId } : {}),
			...(run ? { iteration: run.iteration } : {}),
			...body,
		} as TraceRecord
		fileFor(sessionId).append(line)
	}

	/** Recording must never reach the agent loop: a failure is logged and the loop goes on. */
	const safe = (what: string, fn: () => void): void => {
		try {
			fn()
		} catch (error) {
			Logger.warn(`[trace] Could not record ${what}: ${errorText(error)}`)
		}
	}

	// --- model requests and replies -----------------------------------------
	const baseFactory = config.agentModelFactory
	config.agentModelFactory = (input) => {
		const model = baseFactory ? baseFactory(input) : input.createDefault()
		const modelId = input.config.modelId
		const agentId = input.agentId
		if (input.config.parentAgentId && agentId && !runs.has(agentId)) {
			runs.set(agentId, { iteration: 0, parentAgentId: input.config.parentAgentId })
		}
		return {
			stream: async function* (request: AgentModelRequest) {
				safe("request", () => {
					const systemPrompt = request.systemPrompt ?? ""
					const written = messagesToWrite(agentId ?? "root", request.messages)
					record(agentId, {
						type: "request",
						modelId,
						...(systemPrompt ? { systemPromptSha256: sha256(systemPrompt) } : {}),
						systemPromptChars: systemPrompt.length,
						messageCount: request.messages.length,
						totalChars: JSON.stringify(request.messages).length,
						tools: request.tools.map((tool) => tool.name),
						fromIndex: written.fromIndex,
						newMessages: written.messages.length,
						...(written.reset ? { reset: true } : {}),
						messages: written.messages.map(compactMessage),
					})
				})
				const startedAt = now()
				let firstContentAt: number | undefined
				let textChars = 0
				let reasoningChars = 0
				const toolCallKeys = new Set<string>()
				let usage: Partial<AgentUsage> | undefined
				let finishReason: string | undefined
				let error: string | undefined
				const observe = (event: AgentModelEvent) => {
					switch (event.type) {
						case "text-delta":
							textChars += event.text.length
							break
						case "reasoning-delta":
							reasoningChars += event.text.length
							break
						case "tool-call-delta":
							toolCallKeys.add(
								event.toolCallId ?? (event.index !== undefined ? `#${event.index}` : `@${toolCallKeys.size}`),
							)
							break
						case "usage":
							usage = { ...(usage ?? {}), ...event.usage }
							break
						case "finish":
							finishReason = event.reason
							if (event.error) {
								error = event.error
							}
							break
						default:
							break
					}
					if (firstContentAt === undefined && event.type !== "usage" && event.type !== "finish") {
						firstContentAt = now()
					}
				}
				try {
					const source = await model.stream(request)
					for await (const event of source) {
						safe("stream event", () => observe(event))
						yield event
					}
				} catch (thrown) {
					error = errorText(thrown)
					throw thrown
				} finally {
					safe("stream", () =>
						record(agentId, {
							type: "stream",
							modelId,
							...(usage?.modelId ? { routedModelId: usage.modelId } : {}),
							...(firstContentAt !== undefined ? { ttftMs: firstContentAt - startedAt } : {}),
							durationMs: now() - startedAt,
							...(finishReason ? { finishReason } : {}),
							...(error ? { error: truncate(error, TOOL_TEXT_CAP) } : {}),
							...(traceUsage(usage) ? { usage: traceUsage(usage) } : {}),
							textChars,
							reasoningChars,
							toolCalls: toolCallKeys.size,
						}),
					)
				}
			},
		}
	}

	// --- tool calls, tool results and run ends --------------------------------
	const base = config.hooks ?? {}
	const remember = (snapshot: BeforeModelContext["snapshot"]) => {
		runs.set(snapshot.agentId, {
			runId: snapshot.runId,
			iteration: snapshot.iteration,
			...(snapshot.parentAgentId ? { parentAgentId: snapshot.parentAgentId } : {}),
		})
		latestAgentId = snapshot.agentId
	}
	config.hooks = {
		...base,
		beforeModel: async (context: BeforeModelContext) => {
			safe("run position", () => remember(context.snapshot))
			return base.beforeModel?.(context)
		},
		beforeTool: async (context: BeforeToolContext) => {
			safe("run position", () => remember(context.snapshot))
			const result = await base.beforeTool?.(context)
			safe("tool_call", () =>
				record(context.snapshot.agentId, {
					type: "tool_call",
					tool: context.toolCall.toolName,
					toolCallId: context.toolCall.toolCallId,
					input: compact(context.input, TOOL_TEXT_CAP),
					...(result?.skip ? { skipped: true } : {}),
					...(result?.stop ? { stopped: true } : {}),
				}),
			)
			return result
		},
		afterTool: async (context: AfterToolContext) => {
			safe("run position", () => remember(context.snapshot))
			safe("tool_result", () =>
				record(context.snapshot.agentId, {
					type: "tool_result",
					tool: context.toolCall.toolName,
					toolCallId: context.toolCall.toolCallId,
					durationMs: context.durationMs,
					ok: context.result.isError !== true,
					output: compact(context.result.output, TOOL_TEXT_CAP),
				}),
			)
			return base.afterTool?.(context)
		},
		afterRun: async (context: AfterRunContext) => {
			safe("run position", () => remember(context.snapshot))
			safe("run_end", () => {
				const { result } = context
				if (result.status === "completed") {
					record(context.snapshot.agentId, {
						type: "run_end",
						status: result.status,
						iterations: result.iterations,
						...(traceUsage(result.usage) ? { usage: traceUsage(result.usage) } : {}),
					})
				} else {
					const error = result.error ? errorText(result.error) : context.snapshot.lastError || result.status
					record(context.snapshot.agentId, {
						type: "error",
						status: result.status,
						iterations: result.iterations,
						error: truncate(error, TOOL_TEXT_CAP),
					})
				}
			})
			return base.afterRun?.(context)
		},
	}

	return {
		recordRouterEvent: (event) => safe("router", () => record(undefined, { type: "router", ...event })),
		flush: () => Promise.all([...files.values()].map((file) => file.flush())).then(() => undefined),
	}
}

/**
 * Deletes the oldest trace files until the folder is under `maxTotalBytes`
 * (200 MB by default). Run once at extension start; never throws.
 */
export async function pruneSessionTraces(options: { dir?: string; maxTotalBytes?: number } = {}): Promise<void> {
	const dir = tracesDir(options.dir)
	const maxTotal = options.maxTotalBytes ?? DEFAULT_MAX_FOLDER_BYTES
	try {
		const names = await fs.readdir(dir).catch(() => [] as string[])
		const files: Array<{ filePath: string; size: number; mtimeMs: number }> = []
		for (const name of names) {
			if (!name.endsWith(".jsonl")) {
				continue
			}
			const filePath = path.join(dir, name)
			const stats = await fs.stat(filePath).catch(() => undefined)
			if (stats?.isFile()) {
				files.push({ filePath, size: stats.size, mtimeMs: stats.mtimeMs })
			}
		}
		let total = files.reduce((sum, file) => sum + file.size, 0)
		files.sort((a, b) => a.mtimeMs - b.mtimeMs)
		for (const file of files) {
			if (total <= maxTotal) {
				break
			}
			await fs.rm(file.filePath, { force: true })
			total -= file.size
		}
	} catch (error) {
		Logger.warn(`[trace] Could not prune ${dir}: ${errorText(error)}`)
	}
}
