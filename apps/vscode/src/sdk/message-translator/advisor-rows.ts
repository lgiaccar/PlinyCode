// Chat rows for the advisor tool (`ask_advisor`, see sdk/advisor/advisor-tool.ts):
// the question, the advice, and a usage row that adds the call's cost to the
// conversation's. Everything is derived from the tool call and its result, so
// the live path and history replay produce the same rows and the cost survives
// reopening a conversation.

import type { ClineMessage, ClineSubagentUsageInfo } from "@shared/ExtensionMessage"
import { ADVISOR_TOOL_NAME } from "../advisor/advisor-settings"
import type { AdvisorToolOutput, AdvisorUsage } from "../advisor/advisor-tool"
import { getStringField, parseToolInput } from "./tool-input-parse"

export function isAdvisorTool(toolName: string): boolean {
	return toolName === ADVISOR_TOOL_NAME
}

function blockquote(text: string): string {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n")
}

/** The "asked the advisor" row, shown from the moment the call starts. */
export function advisorQuestionMessage(input: unknown, ts: number, partial: boolean): ClineMessage {
	const parsed = parseToolInput(input)
	const question = getStringField(parsed, "question")?.trim() ?? ""
	const contextChars = getStringField(parsed, "context")?.trim().length ?? 0
	const text = [
		"**Asked the advisor**",
		...(question ? ["", blockquote(question)] : []),
		...(contextChars > 0 ? ["", `_Sent with ${contextChars.toLocaleString("en-US")} characters of context._`] : []),
	].join("\n")
	return { ts, type: "say", say: "info", text, partial }
}

/** A live result is the object the tool returned; a replayed one is its persisted JSON. */
function parseAdvisorOutput(output: unknown): Partial<AdvisorToolOutput> | undefined {
	const parsed = parseToolInput(output)
	return parsed as Partial<AdvisorToolOutput> | undefined
}

function finiteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function parseUsage(value: unknown): AdvisorUsage | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const usage = value as Partial<AdvisorUsage>
	return {
		inputTokens: finiteNumber(usage.inputTokens),
		outputTokens: finiteNumber(usage.outputTokens),
		cacheReadTokens: finiteNumber(usage.cacheReadTokens),
		cacheWriteTokens: finiteNumber(usage.cacheWriteTokens),
		totalCost: finiteNumber(usage.totalCost),
		...(usage.estimated === true ? { estimated: true } : {}),
	}
}

/** `claude-sonnet-5 · 812 in / 640 out tokens · $0.0120`. */
function callSummary(model: string | undefined, usage: AdvisorUsage | undefined): string {
	const label = model ? model.slice(model.indexOf("/") + 1) : undefined
	const approx = usage?.estimated ? "~" : ""
	return [
		label ? `\`${label}\`` : undefined,
		usage ? `${approx}${usage.inputTokens} in / ${approx}${usage.outputTokens} out tokens` : undefined,
		usage ? `${approx}$${usage.totalCost.toFixed(4)}` : undefined,
	]
		.filter(Boolean)
		.join(" · ")
}

/** A thrown tool error reaches the translator as the JSON of `{ error }`. */
function errorText(error: string): string {
	const parsed = parseToolInput(error)
	return getStringField(parsed, "error") ?? error
}

/**
 * The rows that close an advisor call: the question (no longer partial), the
 * advice or the reason there is none, and the hidden usage row that the task
 * header, the budget check and the history record sum (see getApiMetrics).
 */
export function advisorResultMessages(call: {
	input: unknown
	output: unknown
	error?: string
	questionTs: number
	nextTs: () => number
}): ClineMessage[] {
	const messages: ClineMessage[] = [advisorQuestionMessage(call.input, call.questionTs, false)]
	const info = (text: string) => messages.push({ ts: call.nextTs(), type: "say", say: "info", text, partial: false })

	if (call.error) {
		// Refused or failed before anything was billed.
		info(`**The advisor was not consulted**\n\n${errorText(call.error)}`)
		return messages
	}

	const output = parseAdvisorOutput(call.output)
	const usage = parseUsage(output?.usage)
	const model = typeof output?.model === "string" ? output.model : undefined
	const summary = callSummary(model, usage)
	const suffix = summary ? ` (${summary})` : ""
	if (typeof output?.advice === "string" && output.advice.trim()) {
		info(`**The advisor's answer**${suffix}\n\n${output.advice.trim()}`)
	} else {
		const reason = typeof output?.error === "string" ? output.error : "The advisor gave no answer."
		info(`**The advisor could not answer**${suffix}\n\n${reason}`)
	}

	if (usage) {
		const payload: ClineSubagentUsageInfo = {
			source: "advisor",
			tokensIn: usage.inputTokens,
			tokensOut: usage.outputTokens,
			cacheWrites: usage.cacheWriteTokens,
			cacheReads: usage.cacheReadTokens,
			cost: usage.totalCost,
			...(usage.estimated ? { estimated: true } : {}),
		}
		messages.push({ ts: call.nextTs(), type: "say", say: "subagent_usage", text: JSON.stringify(payload), partial: false })
	}
	return messages
}
