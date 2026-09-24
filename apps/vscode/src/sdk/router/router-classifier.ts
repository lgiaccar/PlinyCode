/**
 * The FreeAuto classifier: one small, fast model call at the start of a turn
 * that reads the request and picks a tier (which route) and whether the model
 * should think. The tier-to-route mapping stays in the rules file, so the
 * classifier can never name a model, only a kind of work.
 *
 * Every failure — timeout, garbage output, a transport error — resolves to
 * "no verdict", and the heuristic routes decide as they would without it.
 */

import type { AgentMessage, AgentModel, AgentModelRequest } from "@plinycode/shared"
import { ROUTER_TIERS, type RouterClassification, type RouterRequestFeatures, type RouterRules } from "./router-types"

const DIGEST_MESSAGES = 6
const DIGEST_CHARS_PER_MESSAGE = 200
const CLASSIFIER_MAX_TOKENS = 256

const INSTRUCTIONS = `You route requests for a coding assistant to a model tier.
Reply with one JSON object and nothing else: {"tier": "quick" | "code" | "reason" | "huge", "think": true | false}

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

/** Extract a verdict from the classifier's reply; undefined for anything unusable. */
export function parseClassification(text: string): RouterClassification | undefined {
	// Reasoning models may still wrap their answer in a think block.
	const answer = text.replace(/<think>[\s\S]*?(<\/think>|$)/g, "")
	for (const match of answer.matchAll(/\{[^{}]*\}/g)) {
		try {
			const parsed = JSON.parse(match[0]) as { tier?: unknown; think?: unknown }
			const tier = typeof parsed.tier === "string" ? parsed.tier.trim().toLowerCase() : undefined
			if (tier && (ROUTER_TIERS as readonly string[]).includes(tier)) {
				return { tier: tier as RouterClassification["tier"], think: parsed.think === true }
			}
		} catch {
			// Not JSON; keep looking.
		}
	}
	return undefined
}

/**
 * Run the classifier. Resolves within `rules.classifier.timeoutMs` even if the
 * model hangs, and aborts the underlying request when the turn is cancelled.
 */
export async function runClassifier(options: {
	model: AgentModel
	request: AgentModelRequest
	features: RouterRequestFeatures
	rules: RouterRules
}): Promise<{ classification?: RouterClassification; error?: string }> {
	const { model, request, features, rules } = options
	const controller = new AbortController()
	const onParentAbort = () => controller.abort()
	request.signal?.addEventListener("abort", onParentAbort, { once: true })
	let timer: ReturnType<typeof setTimeout> | undefined

	const collect = async (): Promise<{ classification?: RouterClassification; error?: string }> => {
		let text = ""
		for await (const event of await model.stream(buildClassifierRequest(request, features, rules, controller.signal))) {
			if (event.type === "text-delta") {
				text += event.text
			} else if (event.type === "finish") {
				if (event.reason === "error") {
					return { error: event.error ?? "classifier call failed" }
				}
				break
			}
		}
		const classification = parseClassification(text)
		return classification ? { classification } : { error: `unusable reply: ${text.slice(0, 80) || "(empty)"}` }
	}

	const timeout = new Promise<{ error: string }>((resolve) => {
		timer = setTimeout(() => {
			controller.abort()
			resolve({ error: `timed out after ${rules.classifier.timeoutMs}ms` })
		}, rules.classifier.timeoutMs)
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
		request.signal?.removeEventListener("abort", onParentAbort)
		controller.abort()
	}
}
