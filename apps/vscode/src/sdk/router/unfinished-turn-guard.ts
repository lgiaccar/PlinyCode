/**
 * Keeps a run going when the model announces its next step but forgets to take
 * it.
 *
 * The agent loop ends a run as soon as a reply carries no tool call. Strong
 * models rarely do that mid-task, but the free self-hosted ones often write
 * "Let me check the log tail." or "I'll update the script:" and stop there, so
 * the task silently ends half done. Real transcripts separate the two cases by
 * the reply's last sentence: a premature stop ends on a colon or with an
 * announcement ("Let me…", "I'll…", "I should…"), while a real final answer
 * ends with a result, a question to the user, or an offer to help further.
 *
 * On such a reply the guard injects one reminder and the loop continues. It
 * never nudges twice in a row (a model that answers the reminder with text
 * again is taken at its word), and at most `maxNudgesPerRun` times per run.
 */

import type { AgentMessage, CompletionGuard } from "@plinycode/shared"

export const UNFINISHED_TURN_REMINDER =
	"[SYSTEM] Your last message said what you would do next, but you did not call a tool, so nothing happened " +
	"and the task is not finished. Continue now by calling the tool for that step. If the task really is " +
	"complete, reply with a short final summary instead."

/** Announcements of a next step, matched in the reply's last sentence. */
const ANNOUNCEMENT =
	/\b(let me|let's|let us|i'll|i will|i'm going to|i am going to|i'm now going to|i should|i need to|i must|now i('ll| will)|next,? i('ll| will))\b/i

/** Endings that hand the turn back to the user on purpose. */
const HAND_BACK = /\b(let me know|if you('d| would)? like|would you like|anything else|should i|do you want|shall i)\b/i

function replyText(message: AgentMessage): string {
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("")
		.trim()
}

/** The last sentence or line of a reply, markdown decoration stripped. */
function lastSentence(text: string): string {
	const pieces = text
		.split(/(?<=[.!?])\s+|\n+/)
		.map((piece) => piece.replace(/^[\s>*#-]+|[*_`]+/g, "").trim())
		.filter(Boolean)
	return pieces[pieces.length - 1] ?? ""
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
	const last = lastSentence(trimmed)
	if (!last || /\?\s*$/.test(last) || HAND_BACK.test(last)) {
		return false
	}
	return ANNOUNCEMENT.test(last)
}

export function createUnfinishedTurnGuard(options: {
	/** Evaluated per reply, so a mid-task model switch takes effect. */
	isActive: () => boolean
	/** Called whenever a reminder is sent, e.g. to show a chat row. */
	onNudge?: (info: { excerpt: string; nudgesThisRun: number }) => void
	maxNudgesPerRun?: number
}): CompletionGuard {
	const maxNudges = options.maxNudgesPerRun ?? 3
	let lastIteration = 0
	let lastNudgeIteration: number | undefined
	let nudgesThisRun = 0

	return ({ message, iteration }) => {
		// Iterations restart at 1 on every run.
		if (iteration <= lastIteration) {
			nudgesThisRun = 0
			lastNudgeIteration = undefined
		}
		lastIteration = iteration

		if (!options.isActive() || nudgesThisRun >= maxNudges) {
			return undefined
		}
		// The reply right after a reminder is the model's considered answer.
		if (lastNudgeIteration !== undefined && iteration === lastNudgeIteration + 1) {
			return undefined
		}
		const text = replyText(message)
		if (!looksUnfinished(text)) {
			return undefined
		}
		nudgesThisRun += 1
		lastNudgeIteration = iteration
		options.onNudge?.({ excerpt: lastSentence(text).slice(0, 120), nudgesThisRun })
		return UNFINISHED_TURN_REMINDER
	}
}
