/**
 * One request to a model outside the agent loop, and what it cost.
 *
 * Shared by the calls the extension makes on the conversation's behalf and
 * bills to it: the advisor (`advisor/advisor-tool.ts`) and the router's image
 * descriptions (`router/router-images.ts`). Each sends one tool-free request,
 * collects the reply within a time limit, and works out the call's cost even
 * when the provider reported none, so it can be shown and counted against the
 * conversation's budget.
 */

import { isPlinySelfHostedModelId, type ModelInfo } from "@plinycode/llms"
import {
	type AgentModel,
	type AgentModelFinishReason,
	type AgentModelRequest,
	type AgentUsage,
	estimateRequestInputTokens,
} from "@plinycode/shared"

/** Tokens and cost of one call, in the buckets a `subagent_usage` row and the history record use. */
export interface ModelCallUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	/** USD. */
	totalCost: number
	/** True when the provider reported no figures and these come from text lengths. */
	estimated?: boolean
}

interface ModelCallReply {
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
 * Stream a model's reply. Resolves within `timeoutMs` even if the model
 * hangs, aborts the request when the parent signal fires, and never throws:
 * what arrived before a failure is returned with it, because it was billed.
 */
export async function collectModelReply(options: {
	model: AgentModel
	request: AgentModelRequest
	timeoutMs: number
	parentSignal?: AbortSignal
	/** Reported when the call fails without saying why. */
	failureText?: string
}): Promise<ModelCallReply> {
	const controller = new AbortController()
	const onParentAbort = () => controller.abort()
	if (options.parentSignal?.aborted) {
		return { text: "", error: "cancelled" }
	}
	options.parentSignal?.addEventListener("abort", onParentAbort, { once: true })
	const reply: ModelCallReply = { text: "" }
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
					reply.error =
						event.error ?? (event.reason === "aborted" ? "cancelled" : (options.failureText ?? "the call failed"))
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
export function hasKnownPrice(modelId: string, info: ModelInfo | undefined): boolean {
	return (
		isPlinySelfHostedModelId(modelId) || (typeof info?.pricing?.input === "number" && typeof info.pricing.output === "number")
	)
}

/** USD for a usage at the catalog's per-million prices; the same arithmetic the gateway uses. */
function costFromPricing(usage: Omit<ModelCallUsage, "totalCost">, pricing: ModelInfo["pricing"]): number {
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
export function resolveCallUsage(
	reply: ModelCallReply,
	request: AgentModelRequest,
	modelId: string,
	info: ModelInfo | undefined,
): ModelCallUsage | undefined {
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
			// Self-hosted models are always free; paid models are priced from the catalog when the
			// gateway reports nothing, or from the gateway's own figure when it does.
			totalCost: isPlinySelfHostedModelId(modelId)
				? 0
				: reported.totalCost && reported.totalCost > 0
					? reported.totalCost
					: costFromPricing(tokens, pricing),
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
