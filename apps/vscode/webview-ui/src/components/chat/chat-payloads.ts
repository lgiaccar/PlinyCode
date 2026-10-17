/**
 * Typed parsing for the JSON a chat message carries in `text`.
 *
 * Many `say`/`ask` rows put a JSON payload in `message.text`. Parsing it while
 * rendering used to throw on a truncated streaming row, an old persisted
 * message or a changed shape, and one throw blanked the whole chat. Every
 * render-path parse goes through `parseSayPayload` (or `parsePayloadText`),
 * which never throws: it returns the value when the JSON parses and has the
 * shape the row reads, and an error message otherwise.
 *
 * The schemas check only what rendering relies on: the root is a plain object
 * and each field the row reads, when present, has the declared type. Absent
 * (or null) fields stay allowed, so every payload that rendered before still
 * renders the same way.
 */
import type {
	ClineApiReqInfo,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClineAskUseSubagents,
	ClineCompactionInfo,
	ClineMessage,
	ClinePlanModeResponse,
	ClineSaySubagentStatus,
	ClineSayTool,
	ClineSubagentUsageInfo,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"

export type PayloadResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** Returns a description of what is wrong with `value`, or undefined when it is fine. */
type Check = (value: unknown, path: string) => string | undefined

/** A named check whose success means the value can be read as a `T`. */
interface PayloadSchema<T> {
	readonly name: string
	readonly check: Check
	/** Phantom field tying the schema to the type it validates; never set. */
	readonly _type?: T
}

function describe(value: unknown): string {
	if (value === null) {
		return "null"
	}
	if (Array.isArray(value)) {
		return "an array"
	}
	return typeof value === "object" ? "an object" : `a ${typeof value}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function primitive(kind: "string" | "number" | "boolean"): Check {
	return (value, path) => (typeof value === kind ? undefined : `${path} should be a ${kind}, got ${describe(value)}`)
}

const str = primitive("string")
const num = primitive("number")
const bool = primitive("boolean")
const record: Check = (value, path) => (isRecord(value) ? undefined : `${path} should be an object, got ${describe(value)}`)

/** Absent and null are both fine; JSON payloads written by older versions use either. */
function optional(check: Check): Check {
	return (value, path) => (value === undefined || value === null ? undefined : check(value, path))
}

function arrayOf(item: Check): Check {
	return (value, path) => {
		if (!Array.isArray(value)) {
			return `${path} should be an array, got ${describe(value)}`
		}
		for (let i = 0; i < value.length; i++) {
			const problem = item(value[i], `${path}[${i}]`)
			if (problem) {
				return problem
			}
		}
		return undefined
	}
}

function shape<T>(fields: { [K in keyof T]?: Check }): Check {
	return (value, path) => {
		if (!isRecord(value)) {
			return `${path} should be an object, got ${describe(value)}`
		}
		for (const [key, check] of Object.entries(fields) as [string, Check | undefined][]) {
			const problem = check?.(value[key], `${path}.${key}`)
			if (problem) {
				return problem
			}
		}
		return undefined
	}
}

function schema<T>(name: string, check: Check): PayloadSchema<T> {
	return { name, check }
}

const optStr = optional(str)
const optNum = optional(num)
const optBool = optional(bool)
const optStrArray = optional(arrayOf(str))

/** `say`/`ask: "tool"` rows and `user_feedback_diff`. */
export const clineSayToolPayload = schema<ClineSayTool>(
	"tool",
	shape<ClineSayTool>({
		tool: optStr,
		path: optStr,
		diff: optStr,
		content: optStr,
		regex: optStr,
		action: optStr,
		newName: optStr,
		filePattern: optStr,
		operationIsLocatedInWorkspace: optBool,
		startLineNumbers: optional(arrayOf(num)),
		readLineStart: optNum,
		readLineEnd: optNum,
	}),
)

/** `say: "api_req_started"` rows. */
export const apiReqInfoPayload = schema<ClineApiReqInfo>(
	"api_req_started",
	shape<ClineApiReqInfo>({
		request: optStr,
		tokensIn: optNum,
		tokensOut: optNum,
		cacheWrites: optNum,
		cacheReads: optNum,
		cost: optNum,
		cancelReason: optStr,
		streamingFailedMessage: optStr,
		estimated: optBool,
		contextBreakdown: optional(record),
		reasoningTokens: optNum,
		modelId: optStr,
	}),
)

/** `say: "subagent_usage"` rows. */
export const subagentUsagePayload = schema<Partial<ClineSubagentUsageInfo>>(
	"subagent_usage",
	shape<ClineSubagentUsageInfo>({
		source: optStr,
		tokensIn: optNum,
		tokensOut: optNum,
		cacheWrites: optNum,
		cacheReads: optNum,
		cost: optNum,
		estimated: optBool,
	}),
)

/** `say`/`ask: "use_mcp_server"` rows. */
export const useMcpServerPayload = schema<ClineAskUseMcpServer>(
	"use_mcp_server",
	shape<ClineAskUseMcpServer>({
		serverName: optStr,
		type: optStr,
		toolName: optStr,
		arguments: optStr,
		uri: optStr,
		description: optStr,
	}),
)

/** `ask: "followup"` rows. Older conversations carry the plain question instead. */
export const askQuestionPayload = schema<ClineAskQuestion>(
	"followup",
	shape<ClineAskQuestion>({ question: optStr, options: optStrArray, selected: optStr }),
)

/** `ask: "plan_mode_respond"` rows. Older conversations carry the plain response instead. */
export const planModeResponsePayload = schema<ClinePlanModeResponse>(
	"plan_mode_respond",
	shape<ClinePlanModeResponse>({ response: optStr, options: optStrArray, selected: optStr }),
)

/** `say`/`ask: "use_subagents"` rows: the prompts, before the sub-agents start. */
export const useSubagentsPayload = schema<ClineAskUseSubagents>(
	"use_subagents",
	shape<ClineAskUseSubagents>({ prompts: arrayOf(optStr) }),
)

const subagentStatusItem = shape<SubagentStatusItem>({
	index: num,
	prompt: optStr,
	status: optStr,
	agentId: optStr,
	cacheReadTokens: optNum,
	cacheWriteTokens: optNum,
	toolCalls: optNum,
	inputTokens: optNum,
	outputTokens: optNum,
	totalCost: optNum,
	contextTokens: optNum,
	contextWindow: optNum,
	contextUsagePercentage: optNum,
	latestToolCall: optStr,
	result: optStr,
	error: optStr,
})

/** `say: "subagent"` rows: the running sub-agents' status. */
export const subagentStatusPayload = schema<ClineSaySubagentStatus>(
	"subagent",
	shape<ClineSaySubagentStatus>({
		status: optStr,
		total: optNum,
		completed: optNum,
		successes: optNum,
		failures: optNum,
		toolCalls: optNum,
		inputTokens: optNum,
		outputTokens: optNum,
		contextWindow: optNum,
		maxContextTokens: optNum,
		maxContextUsagePercentage: optNum,
		items: arrayOf(subagentStatusItem),
	}),
)

/** `say: "compaction"` rows. */
export const compactionPayload = schema<ClineCompactionInfo>(
	"compaction",
	shape<ClineCompactionInfo>({
		status: str,
		mode: optStr,
		tokensBefore: optNum,
		tokensAfter: optNum,
		messagesBefore: optNum,
		messagesAfter: optNum,
	}),
)

/** The metadata at the start of a `say: "hook_status"` row, before the hook's output. */
export interface HookStatusMetadata {
	hookName: string
	toolName?: string
	status: string
	exitCode?: number
	hasJsonResponse?: boolean
	pendingToolInfo?: {
		tool: string
		path?: string
		command?: string
		content?: string
		diff?: string
		regex?: string
		url?: string
		mcpTool?: string
		mcpServer?: string
		resourceUri?: string
	}
	error?: {
		type: "timeout" | "validation" | "execution" | "cancellation"
		message: string
		details?: string
		scriptPath?: string
	}
}

type PendingToolInfo = NonNullable<HookStatusMetadata["pendingToolInfo"]>
type HookError = NonNullable<HookStatusMetadata["error"]>

export const hookStatusPayload = schema<HookStatusMetadata>(
	"hook_status",
	shape<HookStatusMetadata>({
		hookName: str,
		toolName: optStr,
		status: str,
		exitCode: optNum,
		hasJsonResponse: optBool,
		pendingToolInfo: optional(
			shape<PendingToolInfo>({
				tool: optStr,
				path: optStr,
				command: optStr,
				content: optStr,
				diff: optStr,
				regex: optStr,
				url: optStr,
				mcpTool: optStr,
				mcpServer: optStr,
				resourceUri: optStr,
			}),
		),
		error: optional(shape<HookError>({ type: optStr, message: optStr, details: optStr, scriptPath: optStr })),
	}),
)

/** `say: "conditional_rules_applied"` rows. */
interface ConditionalRulesInfo {
	rules: Array<{ name: string; matchedConditions?: Record<string, string[]> }>
}

export const conditionalRulesPayload = schema<ConditionalRulesInfo>(
	"conditional_rules_applied",
	shape<ConditionalRulesInfo>({ rules: arrayOf(shape<ConditionalRulesInfo["rules"][number]>({ name: str })) }),
)

/** `ask: "report_bug"` rows. */
interface BugReportInfo {
	title?: string
	what_happened?: string
	steps_to_reproduce?: string
	api_request_output?: string
	provider_and_model?: string
	operating_system?: string
	system_info?: string
	cline_version?: string
	additional_context?: string
}

export const bugReportPayload = schema<BugReportInfo>(
	"report_bug",
	shape<BugReportInfo>({
		title: optStr,
		what_happened: optStr,
		steps_to_reproduce: optStr,
		api_request_output: optStr,
		provider_and_model: optStr,
		operating_system: optStr,
		system_info: optStr,
		cline_version: optStr,
		additional_context: optStr,
	}),
)

/**
 * Parses `text` as JSON and checks it against `payload`. Empty text reads as
 * `{}`, as the rows always did. Never throws.
 */
export function parsePayloadText<T>(text: string | undefined, payload: PayloadSchema<T>): PayloadResult<T> {
	let value: unknown
	try {
		value = JSON.parse(text || "{}")
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error)
		return { ok: false, error: `${payload.name}: the payload is not valid JSON (${reason})` }
	}
	const problem = payload.check(value, "payload")
	if (problem) {
		return { ok: false, error: `${payload.name}: ${problem}` }
	}
	return { ok: true, value: value as T }
}

/** Parses the JSON payload in a chat message's `text`. Never throws. */
export function parseSayPayload<T>(message: Pick<ClineMessage, "text">, payload: PayloadSchema<T>): PayloadResult<T> {
	return parsePayloadText(message.text, payload)
}
