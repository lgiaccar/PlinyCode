/**
 * The router's completion guard: keeps a run going when a free model stops
 * before the task is done.
 *
 * The agent loop consults it whenever a reply carries no tool call. The guard
 * runs the rules from `unfinished-turn-guard.ts` in order of confidence and
 * answers with a reminder that names what went wrong (a failed command, a
 * promise to "check back later", a reply that trailed off). When no rule fires
 * and the run has used tools, an optional judge — a small model asked whether
 * the request was actually carried out — gets the last word.
 *
 * Escalation instead of resignation: a model that answers a reminder with the
 * same stall gets one stronger reminder and, through `onEscalate`, a different
 * model for the rest of the turn. A third stall in a row is accepted, and at
 * most `maxNudgesPerRun` reminders are sent, so a run can never loop on them.
 */

import type { AgentMessage, CompletionGuard, CompletionGuardContext } from "@plinycode/shared"
import {
	endsWithHandBack,
	lastSentence,
	latestUserRequest,
	looksDegenerate,
	looksLikeLeakedReasoning,
	looksLikeReadinessInsteadOfAction,
	looksLikeWaitBailOut,
	looksUnfinished,
	previousShellFailure,
	replyText,
	type ShellFailure,
} from "./unfinished-turn-guard"

export type GuardRule =
	| "degenerate"
	| "after-failed-command"
	| "after-detached-command"
	| "announcement"
	| "wait-bail-out"
	| "leaked-reasoning"
	| "readiness"
	| "judge"

/** Rules that make sense once per run: repeating them would only nag. */
const SINGLE_SHOT_RULES = new Set<GuardRule>(["after-failed-command", "after-detached-command", "readiness"])

export const UNFINISHED_TURN_REMINDER =
	"[SYSTEM] Your last message said what you would do next, but you did not call a tool, so nothing happened " +
	"and the task is not finished. Continue now by calling the tool for that step. If the task really is " +
	"complete, reply with a short final summary instead."

export const WAIT_BAIL_OUT_REMINDER =
	"[SYSTEM] Your turn ends when you reply without a tool call, and nothing runs for you afterwards: you cannot " +
	"check back later. To wait for a running job, call the `wait` tool (up to 10 minutes per call), then read its " +
	"log or run a status command, and repeat until it finishes or you hit a concrete blocker. If the remaining wait " +
	"is longer than about 30 minutes, ask the user whether to keep polling. Continue now with a tool call."

export const LEAKED_REASONING_REMINDER =
	"[SYSTEM] Your last message reads as unfinished thinking rather than an answer, and it made no tool call. " +
	"Decide what to do, then do it with a tool call in this reply. If the task is complete, give the final result " +
	"in a few sentences instead."

export const DEGENERATE_REMINDER =
	"[SYSTEM] Your last message was corrupted (the same characters repeated for thousands of characters) and " +
	"has been disregarded. Redo the step from the last tool result: continue with the next tool call, or give " +
	"the final result if the task is complete."

export const READINESS_REMINDER =
	"[SYSTEM] The user asked you to run it, not to prepare it. You said it is ready but did not run it. Run it " +
	"now with a tool call and report the actual result. Do not ask permission for something the user already asked for."

export const ESCALATED_REMINDER =
	"[SYSTEM] Second reminder: you again described a step without calling a tool. Emit the tool call in this " +
	"reply; do not describe it. If you cannot act, end with one sentence stating the blocker as a question to the user."

export function failedCommandReminder(failure: ShellFailure): string {
	const what = failure.command ? `The command \`${failure.command.slice(0, 120)}\`` : "The last command"
	const how = failure.exitCode !== undefined ? ` failed with exit code ${failure.exitCode}` : " failed"
	return (
		`[SYSTEM] ${what}${how}, and you ended your turn without resolving it. Do not stop here: fix the problem ` +
		"and rerun the command. If the failure is expected, or you are blocked, say so explicitly and ask the user " +
		"how to proceed."
	)
}

export function detachedCommandReminder(failure: ShellFailure): string {
	const where = failure.logPath ? ` Its output is being written to ${failure.logPath}.` : ""
	return (
		`[SYSTEM] The last command is still running; it was left in the background.${where} You cannot come back ` +
		"to it later: call the `wait` tool, then read the log or run a status command, and repeat until it " +
		"finishes or you have a concrete blocker to report."
	)
}

export function judgeReminder(reason: string | undefined): string {
	const why = reason ? ` ${reason.trim().replace(/\.?$/, ".")}` : ""
	return (
		`[SYSTEM] A check of your reply against the user's request suggests the task is not finished.${why} ` +
		"If everything the user asked for is done, reply with a short final summary. Otherwise continue now with " +
		"the next tool call, and do not ask permission for what the user already asked you to do."
	)
}

/** Prompts that make a detached command something to wait for, not to leave. */
const ASKS_TO_WAIT =
	/\b(wait|until (it|they|the \w+) (finish|complete|end|is done|are done)|when (it|they|it's|they're|its) (done|finished|complete|completed)|report (back )?(when|once|after)|monitor|poll|keep (checking|polling|watching)|status update|every \d+ ?(min|minutes|hours?)|tell me when|let me know when)\b/i

export interface JudgeContext {
	userRequest: string
	message: AgentMessage
	runMessages: readonly AgentMessage[]
	messages: readonly AgentMessage[]
}

export interface JudgeVerdict {
	done: boolean
	reason?: string
}

export interface RouterCompletionGuardOptions {
	/** Evaluated per reply, so a mid-task model switch takes effect. */
	isActive: () => boolean
	/** Current mode; the judge only runs in act mode. */
	getMode?: () => "plan" | "act"
	/** Tool calls the current run has made; the judge only runs after at least one. */
	toolCallsThisRun?: () => number
	/** Called whenever a reminder is sent, e.g. to show a chat row. */
	onNudge?: (info: { rule: GuardRule; excerpt: string; nudgesThisRun: number; escalated: boolean; reason?: string }) => void
	/** Called when a second consecutive stall triggers the stronger reminder. */
	onEscalate?: () => void
	/** Asked whether the task is done when no rule fired. Undefined means no verdict. */
	judge?: (context: JudgeContext) => Promise<JudgeVerdict | undefined>
	/** Reports each judge consultation's outcome. */
	onJudge?: (outcome: "done" | "not-done" | "no-verdict", reason?: string) => void
	maxNudgesPerRun?: number
}

interface RuleHit {
	rule: GuardRule
	reminder: string
}

/** Apply the text rules to a reply, most reliable first. */
export function evaluateReply(
	text: string,
	context: {
		message: AgentMessage
		runMessages?: readonly AgentMessage[]
		userRequest: string
		firedRules: ReadonlySet<GuardRule>
	},
): RuleHit | undefined {
	/** A single-shot rule may fire only if it has not fired yet this run. */
	const once = (rule: GuardRule) => !SINGLE_SHOT_RULES.has(rule) || !context.firedRules.has(rule)
	if (looksDegenerate(text)) {
		return { rule: "degenerate", reminder: DEGENERATE_REMINDER }
	}
	const failure = previousShellFailure(context.runMessages, context.message)
	if (failure?.kind === "failed" && once("after-failed-command") && !endsWithHandBack(text)) {
		return { rule: "after-failed-command", reminder: failedCommandReminder(failure) }
	}
	if (
		failure?.kind === "detached" &&
		once("after-detached-command") &&
		!endsWithHandBack(text) &&
		(looksLikeWaitBailOut(text) || ASKS_TO_WAIT.test(context.userRequest))
	) {
		return { rule: "after-detached-command", reminder: detachedCommandReminder(failure) }
	}
	if (looksUnfinished(text)) {
		return { rule: "announcement", reminder: UNFINISHED_TURN_REMINDER }
	}
	if (looksLikeWaitBailOut(text)) {
		return { rule: "wait-bail-out", reminder: WAIT_BAIL_OUT_REMINDER }
	}
	if (looksLikeLeakedReasoning(text)) {
		return { rule: "leaked-reasoning", reminder: LEAKED_REASONING_REMINDER }
	}
	if (once("readiness") && looksLikeReadinessInsteadOfAction(text, context.userRequest)) {
		return { rule: "readiness", reminder: READINESS_REMINDER }
	}
	return undefined
}

export function createRouterCompletionGuard(options: RouterCompletionGuardOptions): CompletionGuard {
	const maxNudges = options.maxNudgesPerRun ?? 3
	let lastIteration = 0
	let lastNudgeIteration: number | undefined
	let nudgesThisRun = 0
	let consecutiveStalls = 0
	let judgeRuns = 0
	let firedRules = new Set<GuardRule>()

	const resetRun = () => {
		lastNudgeIteration = undefined
		nudgesThisRun = 0
		consecutiveStalls = 0
		judgeRuns = 0
		firedRules = new Set()
	}

	return async ({ message, iteration, runMessages, messages }: CompletionGuardContext) => {
		// Iterations restart at 1 on every run.
		if (iteration <= lastIteration) {
			resetRun()
		}
		lastIteration = iteration

		if (!options.isActive() || nudgesThisRun >= maxNudges) {
			return undefined
		}
		const text = replyText(message)
		const userRequest = latestUserRequest(messages)
		const rightAfterNudge = lastNudgeIteration !== undefined && iteration === lastNudgeIteration + 1

		const hit = evaluateReply(text, { message, runMessages, userRequest, firedRules })
		if (hit) {
			consecutiveStalls = rightAfterNudge ? consecutiveStalls + 1 : 1
			if (consecutiveStalls >= 3) {
				// Two reminders did not help; the model's answer stands.
				return undefined
			}
			const escalated = consecutiveStalls === 2
			nudgesThisRun += 1
			lastNudgeIteration = iteration
			firedRules.add(hit.rule)
			options.onNudge?.({ rule: hit.rule, excerpt: lastSentence(text).slice(0, 120), nudgesThisRun, escalated })
			if (escalated) {
				options.onEscalate?.()
				return ESCALATED_REMINDER
			}
			return hit.reminder
		}
		consecutiveStalls = 0

		// The judge weighs in once per run, only on agentic act-mode runs, and
		// never on the reply that answers a reminder: that reply is the model's
		// considered answer.
		const canJudge =
			options.judge !== undefined &&
			judgeRuns < 1 &&
			!rightAfterNudge &&
			(options.getMode?.() ?? "act") === "act" &&
			(options.toolCallsThisRun?.() ?? 0) > 0 &&
			Boolean(text)
		if (!canJudge || !options.judge) {
			return undefined
		}
		judgeRuns += 1
		const verdict = await options.judge({ userRequest, message, runMessages: runMessages ?? [], messages: messages ?? [] })
		if (!verdict) {
			options.onJudge?.("no-verdict")
			return undefined
		}
		if (verdict.done) {
			options.onJudge?.("done", verdict.reason)
			return undefined
		}
		nudgesThisRun += 1
		lastNudgeIteration = iteration
		firedRules.add("judge")
		options.onJudge?.("not-done", verdict.reason)
		options.onNudge?.({
			rule: "judge",
			excerpt: lastSentence(text).slice(0, 120),
			nudgesThisRun,
			escalated: false,
			...(verdict.reason ? { reason: verdict.reason } : {}),
		})
		return judgeReminder(verdict.reason)
	}
}
