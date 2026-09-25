/**
 * The completion judge: a small model asked, when a run is about to end on a
 * tool-free reply, whether the user's request was actually carried out.
 *
 * It exists for the stops no pattern can catch — "Would you like me to run it
 * now?" after the user said to run it, or "the script is ready" when the
 * request was to run the script. It sees the request, the reply, and what the
 * run did, and answers a JSON verdict. Anything unusable is "no verdict", which
 * the guard treats as done, so at worst the run ends exactly as it does today.
 */

import type { AgentMessage, AgentModel, AgentModelRequest } from "@plinycode/shared"
import type { JudgeContext, JudgeVerdict } from "./completion-guard"
import { collectModelText, extractJsonObjects, looseBoolean } from "./router-classifier"
import { replyText, shellFailureFromResult } from "./unfinished-turn-guard"

const JUDGE_MAX_TOKENS = 256
const REQUEST_CHARS = 2000
const REPLY_CHARS = 3000
const TOOL_RESULT_CHARS = 500
const MAX_TOOL_LINES = 20

const INSTRUCTIONS = `You check whether a coding assistant finished what the user asked before it ended its turn.
Output one JSON object first, before any other text, and nothing after it: {"done": true | false, "reason": "<one sentence>"}

Answer "done": false only when the assistant stopped without doing something the user explicitly asked for in this request: it asked permission for an action the user already asked for, said something is ready instead of doing it, or promised to do it later.
Answer "done": true when the work is finished, when the assistant reports a concrete blocker or error it cannot resolve on its own, when it answers a question the user asked, or when it asks a question that genuinely needs the user's answer before it can go on.
When unsure, answer "done": true.`

/** One line per tool call this run: the tool, and whether its result reported a failure. */
export function toolDigest(runMessages: readonly AgentMessage[]): string[] {
	const lines: string[] = []
	for (const message of runMessages) {
		if (message.role !== "tool") {
			continue
		}
		for (const part of message.content) {
			if (part.type !== "tool-result") {
				continue
			}
			const failure = shellFailureFromResult(part)
			const status =
				part.isError || failure?.kind === "failed" ? "failed" : failure?.kind === "detached" ? "left running" : "ok"
			lines.push(`${part.toolName}: ${status}`)
		}
	}
	return lines.length > MAX_TOOL_LINES
		? [`… ${lines.length - MAX_TOOL_LINES} earlier calls`, ...lines.slice(-MAX_TOOL_LINES)]
		: lines
}

function lastToolResultText(runMessages: readonly AgentMessage[]): string {
	for (let index = runMessages.length - 1; index >= 0; index -= 1) {
		const message = runMessages[index]
		if (message?.role !== "tool") {
			continue
		}
		const part = message.content.find((candidate) => candidate.type === "tool-result")
		if (!part || part.type !== "tool-result") {
			continue
		}
		const text = typeof part.output === "string" ? part.output : (JSON.stringify(part.output) ?? "")
		return text.length > TOOL_RESULT_CHARS ? `${text.slice(0, TOOL_RESULT_CHARS)}…` : text
	}
	return ""
}

/** Head and tail of a long reply, so both the plan and the conclusion are visible. */
function trimReply(text: string): string {
	if (text.length <= REPLY_CHARS) {
		return text
	}
	const half = Math.floor(REPLY_CHARS / 2)
	return `${text.slice(0, half)}\n[…]\n${text.slice(-half)}`
}

/** The short, tool-free request sent to the judge model. */
export function buildJudgeRequest(context: JudgeContext, signal: AbortSignal): AgentModelRequest {
	const tools = toolDigest(context.runMessages)
	const lastResult = lastToolResultText(context.runMessages)
	const prompt = [
		"User's request:",
		context.userRequest.slice(0, REQUEST_CHARS) || "(not available)",
		"",
		"Tool calls the assistant made this turn:",
		tools.length > 0 ? tools.join("\n") : "(none)",
		...(lastResult ? ["", "Last tool result (excerpt):", lastResult] : []),
		"",
		"The assistant's final reply, after which it stopped:",
		trimReply(replyText(context.message)),
	].join("\n")
	return {
		systemPrompt: INSTRUCTIONS,
		messages: [{ id: "freeauto-judge", role: "user", content: [{ type: "text", text: prompt }], createdAt: Date.now() }],
		tools: [],
		signal,
		options: { thinking: false, maxTokens: JUDGE_MAX_TOKENS },
	}
}

/** Extract a verdict from the judge's reply; undefined for anything unusable. */
export function parseJudgeVerdict(text: string): JudgeVerdict | undefined {
	for (const parsed of extractJsonObjects(text)) {
		const done = looseBoolean(parsed.done)
		if (done === undefined) {
			continue
		}
		const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 200) : undefined
		return { done, ...(reason ? { reason } : {}) }
	}
	return undefined
}

/** Ask the judge. Resolves within `timeoutMs`; never throws. */
export async function runCompletionJudge(options: {
	model: AgentModel
	context: JudgeContext
	timeoutMs: number
}): Promise<{ verdict?: JudgeVerdict; error?: string; raw?: string }> {
	const result = await collectModelText({
		model: options.model,
		buildRequest: (signal) => buildJudgeRequest(options.context, signal),
		timeoutMs: options.timeoutMs,
	})
	const raw = result.text?.slice(0, 300)
	if (result.error) {
		return { error: result.error, ...(raw ? { raw } : {}) }
	}
	const verdict = parseJudgeVerdict(result.text ?? "")
	return verdict
		? { verdict }
		: { error: `unusable reply: ${(result.text ?? "").slice(0, 80) || "(empty)"}`, ...(raw ? { raw } : {}) }
}
