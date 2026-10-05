/**
 * `ask_advisor`: lets the agent put one hard question to a stronger model and
 * then carry on itself.
 *
 * A free or cheap model does most of a task well and gets stuck at a few
 * decisions. Routing the whole run to an expensive model pays its price on
 * every routine step; one short answer at the hard step costs a few cents.
 *
 * The advisor is called once, outside the agent loop, the way the router's
 * classifier and completion judge are (`router/router-classifier.ts`). It has
 * no tools and sees only what the call sends plus the user's request for the
 * current run.
 *
 * An advisor call is a paid call, so every call is:
 * - refused when the conversation's budget is spent (`checkBudget`), when the
 *   conversation has used its calls, or when the advisor model has no known
 *   price, since its cost could then not be shown;
 * - reported with its token usage and cost in the tool result. The chat rows
 *   and the conversation's cost are derived from that result
 *   (`message-translator/advisor-rows.ts`), so the cost is still there when
 *   the conversation is reopened from history.
 *
 * A failure throws, which the runtime turns into an error result, and the
 * model carries on alone. The exception is a call that failed after the model
 * had started answering: it was billed, so it returns its estimated cost with
 * the error instead of throwing.
 */

import { isPlinySelfHostedModelId, type ModelInfo, plinyThinkingControls } from "@plinycode/llms"
import {
	type AgentMessage,
	type AgentModel,
	type AgentModelFinishReason,
	type AgentModelRequest,
	type AgentTool,
	type AgentToolContext,
	type AgentUsage,
	estimateRequestInputTokens,
} from "@plinycode/shared"
import { Logger } from "@/shared/services/Logger"
import { latestUserRequest } from "../router/unfinished-turn-guard"
import { ADVISOR_TOOL_NAME, type AdvisorSettings, advisorUnavailableReason } from "./advisor-settings"

/** About 1,100 words: room for a recommendation and its steps, not for an essay. */
const ADVISOR_MAX_OUTPUT_TOKENS = 1_500
const ADVISOR_TIMEOUT_MS = 60_000
// Input caps bound what one call can cost: about 8k tokens in and 1.5k out.
const QUESTION_MAX_CHARS = 4_000
const CONTEXT_MAX_CHARS = 24_000
const USER_REQUEST_MAX_CHARS = 4_000
/** Sessions whose call count is remembered; oldest dropped first. */
const MAX_TRACKED_SESSIONS = 500

const INSTRUCTIONS = `You are a senior software engineer advising an AI coding agent that is working on a task in a user's repository. The agent runs on a weaker model and asks you when it is stuck or faces a hard decision.

You have no tools and cannot see the repository, the conversation, or anything the agent did not put in its message. You cannot ask for more: this is a single exchange. If something essential is missing, state the assumption you are making and what the agent should check first.

Reply with advice the agent can act on at once:
- Start with the recommendation.
- Give the reasoning briefly, then the concrete next steps: what to change, what to run, what to verify.
- Point out any mistake or risk you see in the agent's approach.

Be direct and specific. Keep the reply under 700 words; anything longer is cut off.`

export interface AdvisorUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	/** USD. */
	totalCost: number
	/** True when the provider reported no figures and these come from text lengths. */
	estimated?: boolean
}

/** The tool result. Serialized as JSON for the model and in the persisted conversation. */
export interface AdvisorToolOutput {
	advice?: string
	/** Set instead of `advice` when the call was billed but gave nothing usable. */
	error?: string
	model: string
	usage: AdvisorUsage
}

interface AdvisorToolInput {
	question: string
	context?: string
}

/**
 * Calls made per conversation, kept outside the tool because a conversation
 * outlives its session object: a plan/act switch rebuilds the session and its
 * tools.
 */
export interface AdvisorCallLedger {
	callsBySession: Map<string, number>
	inFlight: Set<string>
}

const processLedger: AdvisorCallLedger = { callsBySession: new Map(), inFlight: new Set() }

interface AdvisorToolDeps {
	/** Read on every call, so a settings change applies to a running conversation. */
	getSettings: () => AdvisorSettings
	/** The model the conversation runs on: a router id or a concrete model. */
	conversationModelId: () => string | undefined
	/** The concrete model that issued the call, when a router picked it. */
	callingModelId?: () => string | undefined
	/** A gateway model for `modelId` on the session's connection; undefined before the first run. */
	createModel: (modelId: string) => AgentModel | undefined
	/** Catalog entry of a model, for its price. */
	modelInfo: (modelId: string) => ModelInfo | undefined
	/**
	 * The conversation budget, checked before each call as it is before a paid
	 * model call. Returns why the call may not be made, or undefined.
	 */
	checkBudget: (sessionId: string) => Promise<string | undefined>
	/** Told what each billed call cost, after the call. */
	onUsage?: (sessionId: string, usage: AdvisorUsage) => void
	ledger?: AdvisorCallLedger
	timeoutMs?: number
}

function clip(text: string, maxChars: number): string {
	return text.length > maxChars ? `${text.slice(0, maxChars)}\n[… cut at ${maxChars} characters]` : text
}

function asText(value: unknown): string {
	return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim()
}

/** The tool-free request sent to the advisor model; the caller adds the abort signal. */
function buildAdvisorRequest(input: {
	question: string
	context?: string
	userRequest: string
	modelId: string
}): AgentModelRequest {
	const prompt = [
		"The user's request to the agent:",
		clip(input.userRequest, USER_REQUEST_MAX_CHARS) || "(not available)",
		"",
		"The agent's question:",
		clip(input.question, QUESTION_MAX_CHARS),
		...(input.context ? ["", "Context the agent provided:", clip(input.context, CONTEXT_MAX_CHARS)] : []),
	].join("\n")
	return {
		systemPrompt: INSTRUCTIONS,
		messages: [{ id: "advisor-question", role: "user", content: [{ type: "text", text: prompt }], createdAt: Date.now() }],
		tools: [],
		options: {
			maxTokens: ADVISOR_MAX_OUTPUT_TOKENS,
			// Like the router: a reasoning switch is sent only to a model it was
			// measured on. The gateway rejects the field elsewhere, so a hosted
			// model keeps its default.
			...(plinyThinkingControls(input.modelId) ? { thinking: false } : {}),
		},
	}
}

interface AdvisorReply {
	text: string
	/** Summed over the stream's usage events; undefined when there were none. */
	usage?: Partial<AgentUsage>
	finishReason?: AgentModelFinishReason
	error?: string
	timedOut?: boolean
}

function addUsage(total: Partial<AgentUsage> | undefined, usage: Partial<AgentUsage>): Partial<AgentUsage> {
	const sum = (key: "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens") =>
		(total?.[key] ?? 0) + (usage[key] ?? 0)
	const cost =
		total?.totalCost === undefined && usage.totalCost === undefined
			? undefined
			: (total?.totalCost ?? 0) + (usage.totalCost ?? 0)
	return {
		inputTokens: sum("inputTokens"),
		outputTokens: sum("outputTokens"),
		cacheReadTokens: sum("cacheReadTokens"),
		cacheWriteTokens: sum("cacheWriteTokens"),
		...(cost !== undefined ? { totalCost: cost } : {}),
		...(total?.estimated || usage.estimated ? { estimated: true } : {}),
	}
}

/**
 * Stream the advisor's reply. Resolves within `timeoutMs` even if the model
 * hangs, aborts the request when the run is cancelled, and never throws: what
 * arrived before a failure is returned with it, because it was billed.
 */
async function collectAdvisorReply(options: {
	model: AgentModel
	request: AgentModelRequest
	timeoutMs: number
	parentSignal?: AbortSignal
}): Promise<AdvisorReply> {
	const controller = new AbortController()
	const onParentAbort = () => controller.abort()
	if (options.parentSignal?.aborted) {
		return { text: "", error: "cancelled" }
	}
	options.parentSignal?.addEventListener("abort", onParentAbort, { once: true })
	const reply: AdvisorReply = { text: "" }
	let timer: ReturnType<typeof setTimeout> | undefined

	const collect = async (): Promise<void> => {
		for await (const event of await options.model.stream({ ...options.request, signal: controller.signal })) {
			if (event.type === "text-delta") {
				reply.text += event.text
			} else if (event.type === "usage") {
				reply.usage = addUsage(reply.usage, event.usage)
			} else if (event.type === "finish") {
				reply.finishReason = event.reason
				if (event.reason === "error" || event.reason === "aborted") {
					reply.error = event.error ?? (event.reason === "aborted" ? "cancelled" : "the advisor call failed")
				}
				break
			}
		}
	}
	const timeout = new Promise<void>((resolve) => {
		timer = setTimeout(() => {
			reply.timedOut = true
			reply.error = `timed out after ${Math.round(options.timeoutMs / 1000)} s`
			controller.abort()
			resolve()
		}, options.timeoutMs)
	})

	try {
		await Promise.race([
			collect().catch((error: unknown) => {
				// The abort a timeout causes surfaces here too; its message stays.
				reply.error ??= error instanceof Error ? error.message : String(error)
			}),
			timeout,
		])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
		options.parentSignal?.removeEventListener("abort", onParentAbort)
		controller.abort()
	}
	if (!reply.error && options.parentSignal?.aborted) {
		reply.error = "cancelled"
	}
	return reply
}

/** Whether what a call to this model costs can be worked out: a listed price, or a free model. */
function hasKnownPrice(modelId: string, info: ModelInfo | undefined): boolean {
	return (
		isPlinySelfHostedModelId(modelId) || (typeof info?.pricing?.input === "number" && typeof info.pricing.output === "number")
	)
}

/** USD for a usage at the catalog's per-million prices; the same arithmetic the gateway uses. */
function costFromPricing(usage: Omit<AdvisorUsage, "totalCost">, pricing: ModelInfo["pricing"]): number {
	const inputPrice = pricing?.input ?? 0
	const billableInput = Math.max(0, usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens)
	return (
		(billableInput * inputPrice +
			usage.outputTokens * (pricing?.output ?? 0) +
			usage.cacheReadTokens * (pricing?.cacheRead ?? 0) +
			usage.cacheWriteTokens * (pricing?.cacheWrite ?? inputPrice * 1.25)) /
		1_000_000
	)
}

/**
 * What a call cost. Uses the provider's figures when it reported them, prices
 * them from the catalog when it gave tokens without a cost, and estimates
 * from text lengths when it reported nothing (a timeout, a broken stream).
 * Undefined when nothing was billed: the call failed before any output.
 */
function resolveUsage(
	reply: AdvisorReply,
	request: AgentModelRequest,
	modelId: string,
	info: ModelInfo | undefined,
): AdvisorUsage | undefined {
	const pricing = isPlinySelfHostedModelId(modelId) ? undefined : info?.pricing
	const reported = reply.usage
	if (reported && ((reported.inputTokens ?? 0) > 0 || (reported.outputTokens ?? 0) > 0)) {
		const tokens = {
			inputTokens: reported.inputTokens ?? 0,
			outputTokens: reported.outputTokens ?? 0,
			cacheReadTokens: reported.cacheReadTokens ?? 0,
			cacheWriteTokens: reported.cacheWriteTokens ?? 0,
		}
		return {
			...tokens,
			// A paid model never costs nothing: a missing or zero figure is priced from the catalog.
			totalCost: reported.totalCost && reported.totalCost > 0 ? reported.totalCost : costFromPricing(tokens, pricing),
			...(reported.estimated ? { estimated: true } : {}),
		}
	}
	if (!reply.text && !reply.timedOut) {
		return undefined
	}
	const tokens = {
		inputTokens: estimateRequestInputTokens({
			systemPrompt: request.systemPrompt,
			messages: request.messages,
			tools: request.tools,
		}),
		outputTokens: Math.ceil(reply.text.length / 4),
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	}
	return { ...tokens, totalCost: costFromPricing(tokens, pricing), estimated: true }
}

/** Advisor answers already in the conversation: the count that survives a restart. */
function answeredCalls(messages: readonly AgentMessage[] | undefined): number {
	let count = 0
	for (const message of messages ?? []) {
		for (const part of message.content) {
			if (part.type === "tool-result" && part.toolName === ADVISOR_TOOL_NAME && !part.isError) {
				count += 1
			}
		}
	}
	return count
}

function rememberCall(ledger: AdvisorCallLedger, sessionKey: string, count: number): void {
	ledger.callsBySession.delete(sessionKey)
	ledger.callsBySession.set(sessionKey, count)
	if (ledger.callsBySession.size > MAX_TRACKED_SESSIONS) {
		const oldest = ledger.callsBySession.keys().next().value
		if (oldest !== undefined) {
			ledger.callsBySession.delete(oldest)
		}
	}
}

export function createAdvisorTool(deps: AdvisorToolDeps): AgentTool {
	const ledger = deps.ledger ?? processLedger
	const timeoutMs = deps.timeoutMs ?? ADVISOR_TIMEOUT_MS

	return {
		name: ADVISOR_TOOL_NAME,
		description:
			"Ask a stronger model for advice on one hard decision, then carry on yourself. The advisor has no tools " +
			"and cannot see the repository or this conversation: it sees only the `question` and `context` you send, " +
			"plus the user's original request, which is attached for you. Put everything it needs in `context`: the " +
			"relevant code, the exact error text, what you already tried. Use it when you are stuck after two failed " +
			"attempts at the same problem, when choosing between designs, when the root cause of a bug is unclear, or " +
			"before a risky or hard-to-undo change. Do not use it for routine steps or for anything your own tools " +
			"can find out. Each call costs money and only a few are allowed per conversation, one at a time. The " +
			"answer is advice, not a result: check it against the code before you act on it.",
		inputSchema: {
			type: "object",
			properties: {
				question: {
					type: "string",
					description: "The decision or problem you need advice on, as one specific question.",
				},
				context: {
					type: "string",
					description:
						"What the advisor needs to answer: the relevant code, exact error messages, what you tried and " +
						`what happened, the options you are weighing. At most ${CONTEXT_MAX_CHARS} characters.`,
				},
			},
			required: ["question"],
		},
		// A second call must not overlap the first, and a failed one is not retried: both would be paid twice.
		executionMode: "sequential",
		retryable: false,
		timeoutMs: timeoutMs + 30_000,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<AdvisorToolOutput> {
			const input = (rawInput ?? {}) as Partial<AdvisorToolInput>
			const question = asText(input.question)
			if (!question) {
				throw new Error("ask_advisor needs a `question`.")
			}
			// Sub-agents are not given the tool; this covers a call made anyway.
			if (context.snapshot?.parentAgentId) {
				throw new Error("The advisor is not available to sub-agents. Decide on your own.")
			}
			const settings = deps.getSettings()
			const unavailable = advisorUnavailableReason(settings, deps.conversationModelId())
			if (unavailable) {
				throw new Error(`${unavailable} Decide on your own.`)
			}
			if (deps.callingModelId?.() === settings.model) {
				throw new Error(
					"You are already running on the advisor model, so there is no stronger model to ask. Decide on your own.",
				)
			}

			const sessionKey = context.sessionId ?? context.conversationId ?? "(no session)"
			const used = Math.max(ledger.callsBySession.get(sessionKey) ?? 0, answeredCalls(context.snapshot?.messages))
			if (used >= settings.maxCallsPerConversation) {
				throw new Error(
					`The advisor has been asked ${used} time${used === 1 ? "" : "s"} in this conversation, which is the limit ` +
						`(${settings.maxCallsPerConversation}). Do not call ask_advisor again: decide on your own, or ask the user.`,
				)
			}
			if (ledger.inFlight.has(sessionKey)) {
				throw new Error("The advisor is already answering a question. Wait for that answer before asking another.")
			}
			const info = deps.modelInfo(settings.model)
			if (!hasKnownPrice(settings.model, info)) {
				throw new Error(
					`The advisor model ${settings.model} has no known price, so what the call costs could not be tracked. ` +
						"The call was not made (plinycode.advisor.model). Decide on your own.",
				)
			}

			// Held from here to the end of the call, so the budget is not read twice for one slot.
			ledger.inFlight.add(sessionKey)
			try {
				const overBudget = await deps.checkBudget(sessionKey)
				if (overBudget) {
					throw new Error(`${overBudget} The advisor was not asked. Decide on your own.`)
				}
				const model = deps.createModel(settings.model)
				if (!model) {
					throw new Error("The advisor is not ready yet. Decide on your own.")
				}

				const request = buildAdvisorRequest({
					question,
					context: asText(input.context) || undefined,
					userRequest: latestUserRequest(context.snapshot?.messages),
					modelId: settings.model,
				})
				// Counted when sent, not when answered: a call that times out was still paid for.
				rememberCall(ledger, sessionKey, used + 1)
				const startedAt = Date.now()
				const reply = await collectAdvisorReply({ model, request, timeoutMs, parentSignal: context.signal })
				const usage = resolveUsage(reply, request, settings.model, info)
				if (usage) {
					deps.onUsage?.(sessionKey, usage)
				}
				const advice = reply.text.trim()
				Logger.log(
					`[Advisor] ${settings.model} call ${used + 1}/${settings.maxCallsPerConversation} for ${sessionKey}: ` +
						`${reply.error ? `failed (${reply.error})` : `${advice.length} chars`} in ${Date.now() - startedAt}ms` +
						(usage ? ` · $${usage.totalCost.toFixed(4)}${usage.estimated ? " (estimated)" : ""}` : ""),
				)

				const failure = reply.error ?? (advice ? undefined : "the advisor returned an empty answer")
				if (failure || !usage) {
					const message = `The advisor could not answer: ${failure ?? "its answer came without a usage record"}. Decide on your own.`
					if (!usage) {
						throw new Error(message)
					}
					return { error: message, model: settings.model, usage }
				}
				return {
					advice:
						reply.finishReason === "max-tokens"
							? `${advice}\n\n[The advice was cut off at its length limit.]`
							: advice,
					model: settings.model,
					usage,
				}
			} finally {
				ledger.inFlight.delete(sessionKey)
			}
		},
	}
}
