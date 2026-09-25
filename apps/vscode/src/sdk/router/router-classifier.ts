/**
 * The FreeAuto classifier: one small, fast model call at the start of a turn
 * that reads the request and picks a tier (which route) and whether the model
 * should think. The tier-to-route mapping stays in the rules file, so the
 * classifier can never name a model, only a kind of work.
 *
 * Every failure — timeout, garbage output, a transport error — resolves to
 * "no verdict", and the heuristic routes decide as they would without it. The
 * raw reply travels with the failure so the reason can be logged: the first
 * weeks of the smart profile produced no verdict at all, silently.
 *
 * `collectModelText` and `extractJsonObjects` are shared with the completion
 * judge (`router-completion-judge.ts`), which asks the same utility model a
 * different one-shot question.
 */

import type { AgentMessage, AgentModel, AgentModelRequest } from "@plinycode/shared"
import { ROUTER_TIERS, type RouterClassification, type RouterRequestFeatures, type RouterRules } from "./router-types"

const DIGEST_MESSAGES = 6
const DIGEST_CHARS_PER_MESSAGE = 200
/**
 * Room for a verbose model: the probe showed the default classifier model
 * filling 256 tokens on a trivial prompt, which truncated the verdict away.
 */
const CLASSIFIER_MAX_TOKENS = 512

const INSTRUCTIONS = `You route requests for a coding assistant to a model tier.
Output one JSON object first, before any other text, and nothing after it: {"tier": "quick" | "code" | "reason" | "huge", "think": true | false}

Tiers:
- quick: a short factual question, or a trivial one-line change.
- code: writing, editing, fixing, testing, refactoring or merging code.
- reason: planning, design, architecture, reviewing, comparing options, or debugging a cause that is not yet known.
- huge: the work needs a very large context, such as analysing a whole repository or many large files at once.

Set "think" to true only when careful step-by-step reasoning will clearly improve the result:
planning, design trade-offs, tricky bugs, subtle logic. Use false for routine work, where it only adds delay.`

function messageText(message: AgentMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
}

/** The short, tool-free request sent to the classifier model. */
export function buildClassifierRequest(
	request: AgentModelRequest,
	features: RouterRequestFeatures,
	rules: RouterRules,
	signal: AbortSignal,
): AgentModelRequest {
	const earlier = request.messages
		.slice(0, -1)
		.map((message) => ({ role: message.role, text: messageText(message) }))
		.filter((entry) => entry.text)
		.slice(-DIGEST_MESSAGES)
		.map((entry) => `[${entry.role}] ${entry.text.slice(0, DIGEST_CHARS_PER_MESSAGE)}`)

	const prompt = [
		`Mode: ${features.mode}`,
		`Conversation size: about ${Math.round(features.estimatedTokens / 1000)}k tokens`,
		...(earlier.length > 0 ? ["", "Recent conversation:", ...earlier] : []),
		"",
		"Latest request:",
		features.prompt.slice(0, rules.classifier.maxPromptChars),
	].join("\n")

	const guidance = rules.guidance?.trim()
	return {
		systemPrompt: guidance ? `${INSTRUCTIONS}\n\nAdditional guidance from the user's rules file:\n${guidance}` : INSTRUCTIONS,
		messages: [{ id: "freeauto-classifier", role: "user", content: [{ type: "text", text: prompt }], createdAt: Date.now() }],
		tools: [],
		signal,
		options: { thinking: false, maxTokens: CLASSIFIER_MAX_TOKENS },
	}
}

/**
 * Every balanced `{…}` in the text, outermost first, as parsed objects.
 * Anything that is not valid JSON is skipped. Closed think blocks are removed
 * first; an unclosed one is left in, since a verdict may be inside it.
 */
export function extractJsonObjects(text: string): Record<string, unknown>[] {
	const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "")
	const objects: Record<string, unknown>[] = []
	let depth = 0
	let start = -1
	let inString = false
	let escaped = false
	for (let index = 0; index < cleaned.length; index += 1) {
		const char = cleaned[index]
		if (inString) {
			if (escaped) {
				escaped = false
			} else if (char === "\\") {
				escaped = true
			} else if (char === '"') {
				inString = false
			}
			continue
		}
		if (char === '"' && depth > 0) {
			inString = true
		} else if (char === "{") {
			if (depth === 0) {
				start = index
			}
			depth += 1
		} else if (char === "}" && depth > 0) {
			depth -= 1
			if (depth === 0 && start >= 0) {
				try {
					const parsed: unknown = JSON.parse(cleaned.slice(start, index + 1))
					if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
						objects.push(parsed as Record<string, unknown>)
					}
				} catch {
					// Not JSON; keep scanning.
				}
				start = -1
			}
		}
	}
	return objects
}

/** `true`/`false`, also when the model quoted them. */
export function looseBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") {
		return value
	}
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase()
		if (normalized === "true") {
			return true
		}
		if (normalized === "false") {
			return false
		}
	}
	return undefined
}

/** Extract a verdict from the classifier's reply; undefined for anything unusable. */
export function parseClassification(text: string): RouterClassification | undefined {
	for (const parsed of extractJsonObjects(text)) {
		const tier = typeof parsed.tier === "string" ? parsed.tier.trim().toLowerCase() : undefined
		if (tier && (ROUTER_TIERS as readonly string[]).includes(tier)) {
			return { tier: tier as RouterClassification["tier"], think: looseBoolean(parsed.think) === true }
		}
	}
	return undefined
}

/**
 * Stream one short reply out of a utility model. Resolves within `timeoutMs`
 * even if the model hangs, and aborts the underlying request when the parent
 * request is cancelled. Never throws.
 */
export async function collectModelText(options: {
	model: AgentModel
	buildRequest: (signal: AbortSignal) => AgentModelRequest
	timeoutMs: number
	parentSignal?: AbortSignal
}): Promise<{ text?: string; error?: string }> {
	const controller = new AbortController()
	const onParentAbort = () => controller.abort()
	options.parentSignal?.addEventListener("abort", onParentAbort, { once: true })
	let timer: ReturnType<typeof setTimeout> | undefined

	const collect = async (): Promise<{ text?: string; error?: string }> => {
		let text = ""
		for await (const event of await options.model.stream(options.buildRequest(controller.signal))) {
			if (event.type === "text-delta") {
				text += event.text
			} else if (event.type === "finish") {
				if (event.reason === "error") {
					return { error: event.error ?? "utility model call failed", ...(text ? { text } : {}) }
				}
				break
			}
		}
		return { text }
	}

	const timeout = new Promise<{ error: string }>((resolve) => {
		timer = setTimeout(() => {
			controller.abort()
			resolve({ error: `timed out after ${options.timeoutMs}ms` })
		}, options.timeoutMs)
	})

	try {
		return await Promise.race([
			collect().catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })),
			timeout,
		])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
		options.parentSignal?.removeEventListener("abort", onParentAbort)
		controller.abort()
	}
}

/**
 * Run the classifier. Resolves within `rules.classifier.timeoutMs` even if the
 * model hangs, and aborts the underlying request when the turn is cancelled.
 * On failure `raw` carries the start of whatever the model said, for the log.
 */
export async function runClassifier(options: {
	model: AgentModel
	request: AgentModelRequest
	features: RouterRequestFeatures
	rules: RouterRules
}): Promise<{ classification?: RouterClassification; error?: string; raw?: string }> {
	const { model, request, features, rules } = options
	const result = await collectModelText({
		model,
		buildRequest: (signal) => buildClassifierRequest(request, features, rules, signal),
		timeoutMs: rules.classifier.timeoutMs,
		parentSignal: request.signal,
	})
	const raw = result.text?.slice(0, 300)
	if (result.error) {
		return { error: result.error, ...(raw ? { raw } : {}) }
	}
	const classification = parseClassification(result.text ?? "")
	if (classification) {
		return { classification }
	}
	return { error: `unusable reply: ${(result.text ?? "").slice(0, 80) || "(empty)"}`, ...(raw ? { raw } : {}) }
}
