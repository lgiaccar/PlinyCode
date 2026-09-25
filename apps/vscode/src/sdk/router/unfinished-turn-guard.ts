/**
 * Rules that tell a premature stop from a real final answer.
 *
 * The agent loop ends a run as soon as a reply carries no tool call. Strong
 * models rarely do that mid-task, but the free self-hosted ones do, in a few
 * recognisable ways collected from real FreeAuto transcripts:
 *
 * - they announce the next step and stop ("Let me check the log tail:");
 * - they end on their own to-do list ("I need to: 1. Check the logs 2. Report")
 *   without taking the first step;
 * - they promise to come back later ("I'll check again at 15:28. Stand by!"),
 *   which they cannot do — nothing runs once the turn is over;
 * - they think out loud in prose and trail off mid-sentence;
 * - they stop right after a command failed, reporting the failure as if it
 *   were the result;
 * - they degenerate into a repeated token for thousands of characters.
 *
 * Every rule here is a pure function of text (and, for the shell rule, of the
 * run's messages), so it can be tested against transcript endings. The guard
 * that applies them lives in `completion-guard.ts`.
 */

import type { AgentMessage, AgentToolResultPart } from "@plinycode/shared"

/** Announcements of a next step, matched in the reply's last sentence. */
const ANNOUNCEMENT =
	/\b(let me|let's|let us|i'll|i will|i'm going to|i am going to|i'm now going to|i should|i need to|i must|now i('ll| will)|next,? i('ll| will))\b/i

/** Endings that hand the turn back to the user on purpose. */
const HAND_BACK = /\b(let me know|if you('d| would)? like|would you like|anything else|should i|do you want|shall i)\b/i

export function replyText(message: AgentMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim()
}

/** Sentences or lines of a reply, markdown decoration stripped, empty ones dropped. */
function sentences(text: string): string[] {
	return text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((piece) => piece.replace(/^[\s>*#-]+|[*_`]+/g, "").trim())
		.filter(Boolean)
}

/** The last sentence or line of a reply, markdown decoration stripped. */
export function lastSentence(text: string): string {
	const pieces = sentences(text)
	return pieces[pieces.length - 1] ?? ""
}

/** The reply's closing: its last three sentences joined. */
function closing(text: string): string {
	return sentences(text).slice(-3).join(" ")
}

/** True when the reply ends by asking the user something or offering to go on. */
export function endsWithHandBack(text: string): boolean {
	const last = lastSentence(text)
	return /\?\s*$/.test(last) || HAND_BACK.test(last)
}

/** True when a tool-free reply announces work it did not do. */
export function looksUnfinished(text: string): boolean {
	const trimmed = text.trim()
	if (!trimmed) {
		return false
	}
	// "…to be simpler and more focused on validation:" — the call that should follow is missing.
	if (/:\s*$/.test(trimmed)) {
		return true
	}
	if (endsWithPlanList(trimmed)) {
		return true
	}
	const last = lastSentence(trimmed)
	if (!last || endsWithHandBack(trimmed)) {
		return false
	}
	return ANNOUNCEMENT.test(last)
}

/** A line that introduces the model's own plan, as opposed to a summary or a list of options. */
const PLAN_INTRO =
	/\b(i need to|i should|i'll|i will|i'm going to|i am going to|let me|i must|i plan to|my plan|the plan is|here's (my|the) plan|steps? i('ll| will) take)\b/i

/** A list item: `1.`, `1)`, `-`, `*`, `•`, with optional markdown emphasis after it. */
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*•])\s+[*_`]*(\S.*)$/

/** Imperative verbs that open a step in a to-do list, as opposed to a result line ("Wall time: 476s"). */
const IMPERATIVE_STEP =
	/^(check|verify|confirm|inspect|examine|look|read|open|list|find|search|locate|get|extract|parse|collect|gather|run|execute|launch|start|kick|rerun|re-run|build|compile|install|test|create|write|add|append|update|edit|modify|fix|remove|delete|move|copy|rename|generate|implement|complete|finish|continue|wait|poll|monitor|watch|report|give|provide|show|display|print|summarize|summarise|compare|analyze|analyse|determine|identify|ensure|make|prepare|load|save|set|use|call|try|apply|clean|reset|restart|stop|kill|switch|checkout|pull|push|commit|merge|clone|fetch|document|review)\b/i

/**
 * True when the reply ends with the model's to-do list: an "I need to:" line
 * followed by imperative steps and nothing after. Reasoning models that think
 * in their content end this way — the plan is the whole reply, and the first
 * step's tool call never comes. A results list ("- stage: 476s") or a list of
 * options for the user does not match: it needs both the first-person intro
 * and imperative items.
 */
export function endsWithPlanList(text: string): boolean {
	const lines = text
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
	let index = lines.length - 1
	const items: string[] = []
	while (index >= 0) {
		const match = lines[index]?.match(LIST_ITEM)
		if (!match?.[1]) {
			break
		}
		items.unshift(match[1])
		index -= 1
	}
	if (items.length < 2 || !items.every((item) => IMPERATIVE_STEP.test(item))) {
		return false
	}
	const intro = lines[index] ?? ""
	return PLAN_INTRO.test(intro)
}

/**
 * Promises to act later. The model has no later: once the turn ends nothing
 * runs for it, so "I'll check again at 15:28" is a stop, not a plan.
 */
const WAIT_BAIL_OUT = [
	/\b(i(?:'ll| will)|let me|i can|i'm going to) (check|look|report|follow up|get back|update|circle back|be back|come back|review|verify|monitor)\b[^.!?]{0,60}\b(back|again|later|shortly|soon|periodically|in \d+|at \d{1,2}:\d{2}|mark|when|once|after)\b/i,
	/\b(i(?:'ll| will)|let me|i'm going to|i am going to) (just )?(wait|monitor|keep (an eye|watching|monitoring|polling|checking)|check (back|again|in|on it))\b/i,
	/\bstand by\b/i,
	/\bnothing (to do|left(?: to do)?|more to do|else to do) (but|except|other than|than) (to )?wait\b/i,
	/\b(cannot|can't|can not|won't be able to|am not able to|unable to) (sit|stay|wait|remain|keep watching|keep monitoring|monitor|watch)\b/i,
	/\b(message|ping|ask|tell|prompt|call) me (later|again|back|when|once|after|in)\b/i,
	/\btimer is running\b/i,
	/\bwill (keep|continue) running on its own\b/i,
]

/** True when the reply's closing defers work to a later moment the model will never see. */
export function looksLikeWaitBailOut(text: string): boolean {
	const tail = closing(text)
	return Boolean(tail) && WAIT_BAIL_OUT.some((pattern) => pattern.test(tail))
}

/** Words a sentence does not end on; a reply ending on one trailed off. */
const DANGLING_LAST_WORD =
	/\b(in|on|at|to|the|a|an|and|or|but|of|for|with|from|by|is|are|was|were|that|which|if|then|so|because|as|into|onto|this|these|those|it|its|my|i|we|they|he|she|you|be|been|being|have|has|had|will|would|should|could|can|not|no|very|also|just|now|first|then|about|after|before|while|when|where|whether)$/i

const THINKING_ALOUD = /(^|[.!?]\s+|\n\s*)(hmm+|wait|actually|okay|ok|so|but|alright|right)\b[,.!:]?\s/gi
const NARRATING_USER = /\bthe user (wants|asked|said|is asking|keeps|expects|needs)\b/gi

/**
 * True when a non-thinking model reasoned in prose instead of acting: it
 * argues with itself for several sentences, narrates what "the user wants", or
 * simply trails off mid-sentence.
 */
export function looksLikeLeakedReasoning(text: string): boolean {
	const trimmed = text.trim()
	if (!trimmed) {
		return false
	}
	if ((trimmed.match(THINKING_ALOUD) ?? []).length >= 3) {
		return true
	}
	if ((trimmed.match(NARRATING_USER) ?? []).length >= 2) {
		return true
	}
	const lastLine = trimmed.split("\n").pop()?.trim() ?? ""
	const isProse = lastLine.length > 40 && !/^([-*+>#|]|\d+[.)]|```)/.test(lastLine)
	return isProse && !/[.!?:;)\]"'`*_~]$/.test(lastLine) && DANGLING_LAST_WORD.test(lastLine)
}

/**
 * True when a long reply is mostly one short unit repeated — " .   .   .",
 * "]]]]" — which is a broken generation, not an answer.
 */
export function looksDegenerate(text: string, minChars = 2000): boolean {
	if (text.length < minChars) {
		return false
	}
	const tail = text.slice(-1500).replace(/\s+/g, " ")
	if (/(.{1,8}?)\1{30,}\s*$/.test(tail)) {
		return true
	}
	const size = 8
	const grams = new Set<string>()
	for (let index = 0; index + size <= tail.length; index += 1) {
		grams.add(tail.slice(index, index + size))
	}
	return grams.size / Math.max(1, tail.length - size + 1) < 0.05
}

/** "Ready to run", said to a user who asked for it to be run. */
const READINESS =
	/\b(is|are|it's|script is|everything is) (now )?(all )?ready (to|for) (run|execute|launch|use|go|be run|be executed|start|testing|execution)\b/i
const ASKS_TO_RUN = /\b(run|execute|launch|start|kick off|try it)\b/i

/** True when the reply declares something ready to run after the user asked to run it. */
export function looksLikeReadinessInsteadOfAction(text: string, userRequest: string): boolean {
	return Boolean(userRequest) && ASKS_TO_RUN.test(userRequest) && READINESS.test(closing(text)) && !endsWithHandBack(text)
}

export interface ShellFailure {
	kind: "failed" | "detached"
	tool: string
	/** The command, when the result named it. */
	command?: string
	exitCode?: number
	/** Where a detached command keeps writing, when the result said. */
	logPath?: string
}

const SHELL_TOOLS = new Set(["run_commands", "bash", "shell", "execute_command"])

function resultText(output: unknown): string {
	if (typeof output === "string") {
		return output
	}
	try {
		return JSON.stringify(output) ?? ""
	} catch {
		return String(output)
	}
}

/**
 * Inspect one shell tool result. Failures arrive as `success: false` entries
 * (with the exit code in `error`) or as `[Command exited with code N]` text;
 * detached commands come back as successes whose text says the command is
 * still running and where its output goes.
 */
export function shellFailureFromResult(part: AgentToolResultPart): ShellFailure | undefined {
	if (!SHELL_TOOLS.has(part.toolName)) {
		return undefined
	}
	const entries = Array.isArray(part.output) ? (part.output as unknown[]) : [part.output]
	for (const entry of entries) {
		const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined
		const text = record ? `${resultText(record.result)}\n${resultText(record.error)}` : resultText(entry)
		const command = typeof record?.query === "string" ? record.query : undefined
		const exit = text.match(/Command exited with code (\d+)/i)
		if (record?.success === false || part.isError || exit || /\bCommand (failed|timed out)\b/i.test(text)) {
			return {
				kind: "failed",
				tool: part.toolName,
				...(command ? { command } : {}),
				...(exit ? { exitCode: Number(exit[1]) } : {}),
			}
		}
		if (
			/still (starting or )?running|automatically proceeded|chose to proceed|Output will continue in|completion could not be observed/i.test(
				text,
			)
		) {
			const log = text.match(/(?:redirected to this file[^:]*:|Output will continue in)\s*(\S+?)(?:\]|\s|$)/i)
			return {
				kind: "detached",
				tool: part.toolName,
				...(command ? { command } : {}),
				...(log ? { logPath: log[1] } : {}),
			}
		}
	}
	return undefined
}

/**
 * The shell failure the reply follows, if the message right before it is a
 * tool result and one of its shell results failed or was left running.
 */
export function previousShellFailure(
	runMessages: readonly AgentMessage[] | undefined,
	reply: AgentMessage,
): ShellFailure | undefined {
	if (!runMessages) {
		return undefined
	}
	const index = runMessages.lastIndexOf(reply)
	const previous = runMessages[index >= 0 ? index - 1 : runMessages.length - 1]
	if (!previous || previous.role !== "tool") {
		return undefined
	}
	for (const part of previous.content) {
		if (part.type !== "tool-result") {
			continue
		}
		const failure = shellFailureFromResult(part)
		if (failure) {
			return failure
		}
	}
	return undefined
}

/** Strip the `<user_input mode="…">` wrapper the host puts around prompts. */
function unwrapUserInput(text: string): string {
	return text
		.replace(/<mode_notice>[\s\S]*?<\/mode_notice>/g, "")
		.replace(/^\s*<user_input[^>]*>/, "")
		.replace(/<\/user_input>\s*$/, "")
		.trim()
}

/**
 * The latest thing the user actually asked for: the last user message that is
 * neither a tool result nor a runtime-injected reminder or hook context.
 */
export function latestUserRequest(messages: readonly AgentMessage[] | undefined): string {
	if (!messages) {
		return ""
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index]
		if (!message || message.role !== "user") {
			continue
		}
		const metadata = message.metadata ?? {}
		if (metadata.displayRole === "system" || metadata.userRunSpan === 0) {
			continue
		}
		if (message.content.some((part) => part.type === "tool-result")) {
			continue
		}
		const text = unwrapUserInput(replyText(message))
		if (text && !text.startsWith("[SYSTEM]") && !text.startsWith("<hook_context")) {
			return text
		}
	}
	return ""
}
