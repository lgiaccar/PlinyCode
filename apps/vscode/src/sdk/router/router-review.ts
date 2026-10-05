/**
 * The reviewer pass: before a routed act-mode run that changed files ends, a
 * model other than the one that wrote the code reads the diff. Defects it is
 * confident about go back to the working model once, as a `[SYSTEM]` reminder
 * to check each one, fix the real ones and say which it dismissed.
 *
 * The completion judge (`router-completion-judge.ts`) asks whether the request
 * was carried out; nothing asked whether what was written is right. This does,
 * at the same point: it runs after the completion guard has accepted the reply
 * that would end the run.
 *
 * It can only add one more round of work, never block a finish: a skipped
 * review, a reviewer that times out, fails or answers with something
 * unreadable, and a cancelled run all end the run exactly as before. The
 * reviewer is always a free model, so the pass itself costs nothing.
 *
 * The pass keeps no state of its own. "Once per turn" is read off the
 * transcript (the reminder is in it) and the run record, so it also holds when
 * a failed run is recovered and continues in a new one.
 */

import { isPlinySelfHostedModelId, type ModelInfo } from "@plinycode/llms"
import type { AgentMessage, AgentModel, AgentModelRequest, CompletionGuard } from "@plinycode/shared"
import { collectModelText, extractJsonObjects } from "./router-classifier"
import { selectCandidates } from "./router-policy"
import {
	assessChanges,
	buildReviewDiff,
	changesFromCheckpoint,
	changesFromToolCalls,
	countSuccessfulEdits,
	currentTurnMessages,
	type ReviewFileChange,
} from "./router-review-diff"
import type { RouterRequestFeatures, RouterRules } from "./router-types"
import { latestUserRequest, replyText } from "./unfinished-turn-guard"

/** A review reads a few thousand tokens of diff and writes up to five findings; the judge's 6 s would cut most off. */
export const REVIEW_TIMEOUT_MS = 45_000
export const REVIEW_MAX_ISSUES = 5
const REVIEW_MAX_TOKENS = 2048
/** The capped diff plus the request and reply excerpts, for the context-window check. */
const REVIEW_ESTIMATED_TOKENS = 10_000
/** A checkpoint comparison is a few git calls; on a repository where they crawl, the edit calls are used instead. */
const CHECKPOINT_DIFF_TIMEOUT_MS = 10_000
const REQUEST_CHARS = 4000
const REPLY_CHARS = 1500
const ISSUE_TEXT_CHARS = 300

const INSTRUCTIONS = `You review a code change made by an AI coding assistant, just before it tells the user the work is finished.
You are given the user's request, the assistant's final message, and a diff of what it changed.
Output one JSON object first, before any other text, and nothing after it:
{"issues": [{"file": "<path as shown in the diff>", "line": <line number in the new file, or null>, "problem": "<what is wrong, one sentence>", "why": "<how you can tell from the diff, one sentence>"}]}

Report only defects you are confident about:
- behaviour that is wrong, or that does not do what the user asked for
- code that will not compile, parse or run: a syntax error, an undefined name, a wrong signature or type
- data that is lost or corrupted
- an unfinished stub or placeholder left where working code is needed
- a part of the request that is missing from the change

Review only what the change added or altered. Code that was already there, and is shown only as context, is not under review.
Do not report style, naming, formatting, comments, missing tests or documentation, performance, or anything you would word as "consider" or "might". The diff shows only the changed lines and a few around them: never report something as undefined or missing when it may exist in code you cannot see.
At most ${REVIEW_MAX_ISSUES} issues, the most serious first. Most changes are fine, and {"issues": []} is the expected answer.`

/** How every review reminder starts; also how a turn that was already reviewed is recognised. */
export const REVIEW_NUDGE_PREFIX = "[SYSTEM] Review before finishing:"

export interface ReviewIssue {
	file?: string
	/** Line in the new file, when the reviewer gave one. */
	line?: number
	problem: string
	why?: string
}

export type ReviewSkipReason =
	| "setting-off"
	| "not-act-mode"
	| "sub-agent"
	| "paid-model"
	| "already-reviewed"
	| "guard-gave-up"
	| "cancelled"
	| "no-changes"
	| "docs-only"
	| "small-change"
	| "no-reviewer"

/** What the pass did for one run. Written to the run log as `review`. */
export interface ReviewRecord {
	/** `issues`: handed back to the model. `clean`: nothing found. `no-verdict`: the reviewer failed. */
	outcome: "issues" | "clean" | "no-verdict" | "skipped"
	/** Why the review was skipped (a `ReviewSkipReason`), or why the reviewer gave no verdict. */
	reason?: string
	/** The reviewing model. */
	model?: string
	issues?: number
	/** How long the reviewer took. */
	durationMs?: number
	/** Where the diff came from. */
	source?: "checkpoint" | "tool-calls"
	/** Files shown to the reviewer. */
	files?: number
	/** The diff did not fit the cap, so the reviewer saw part of it. */
	truncated?: boolean
}

/**
 * The reviewer for a turn: the first healthy, free model of the profile's
 * reasoning route that did not work on the turn, then the rest of the pool in
 * its own order. Candidates come from the router's own selection, so a rules
 * file that reorders the route or the pool reorders the reviewers with it.
 * Paid models are passed over (BalanceAuto's reasoning route is all paid): a
 * second opinion on every run must not be what the user is billed for.
 */
export function pickReviewer(context: {
	rules: RouterRules
	/** Models that answered calls or edited files this turn. */
	authors: ReadonlySet<string>
	isHealthy: (modelId: string) => boolean
	knownModels?: Record<string, ModelInfo>
}): string | undefined {
	const { rules, authors, isHealthy, knownModels } = context
	const features: RouterRequestFeatures = {
		estimatedTokens: REVIEW_ESTIMATED_TOKENS,
		mode: "plan",
		prompt: "review",
		hasImages: false,
		isSubAgent: false,
		callIndex: 1,
	}
	// The classifier's "reason" tier names the reasoning route even in a rules
	// file whose conditions were rewritten; the features match it otherwise.
	const decision = selectCandidates({
		rules,
		features,
		isHealthy,
		classification: { tier: "reason", think: false },
		...(knownModels ? { knownModels } : {}),
	})
	// `selectCandidates` falls back to benched models rather than refuse a call;
	// a review is optional, so here an unhealthy model is simply not asked.
	return decision.candidates.find((id) => isPlinySelfHostedModelId(id) && isHealthy(id) && !authors.has(id))
}

export interface ReviewInput {
	userRequest: string
	/** The reply that would end the run. */
	finalReply: string
	/** From `buildReviewDiff`. */
	diff: string
	files: number
	added: number
	removed: number
	truncated?: boolean
}

/**
 * The tool-free request sent to the reviewing model. Reasoning is switched
 * off, as for the judge: probed on a small diff, the 397B with its default
 * reasoning took 7-12 s, missed a planted defect, and once spent its whole
 * reply on reasoning and returned no content; with reasoning off and a
 * JSON-only reply it found both defects in under 2 s.
 */
export function buildReviewRequest(input: ReviewInput, signal: AbortSignal): AgentModelRequest {
	const reply = input.finalReply.length > REPLY_CHARS ? `[…]\n${input.finalReply.slice(-REPLY_CHARS)}` : input.finalReply
	const prompt = [
		"User's request:",
		input.userRequest.slice(0, REQUEST_CHARS) || "(not available)",
		"",
		"The assistant's final message:",
		reply || "(none)",
		"",
		`What the assistant changed: ${input.files} file${input.files === 1 ? "" : "s"}, +${input.added} -${input.removed} lines` +
			(input.truncated ? " (the diff below is cut to fit; do not report the parts you cannot see as missing)" : ""),
		'Lines starting with "+" were added, lines starting with "-" were removed.',
		"",
		input.diff,
	].join("\n")
	return {
		systemPrompt: INSTRUCTIONS,
		messages: [{ id: "freeauto-review", role: "user", content: [{ type: "text", text: prompt }], createdAt: Date.now() }],
		tools: [],
		signal,
		options: { thinking: false, maxTokens: REVIEW_MAX_TOKENS, responseFormat: "json" },
	}
}

function issueText(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, ISSUE_TEXT_CHARS) : undefined
}

function toIssue(value: unknown): ReviewIssue | undefined {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const raw = value as Record<string, unknown>
	const problem = issueText(raw.problem)
	if (!problem) {
		return undefined
	}
	const file = issueText(raw.file)
	const line = Number(raw.line)
	const why = issueText(raw.why)
	return {
		...(file ? { file } : {}),
		...(raw.line !== null && raw.line !== "" && Number.isInteger(line) && line > 0 ? { line } : {}),
		problem,
		...(why ? { why } : {}),
	}
}

/**
 * The issues in a reviewer's reply, or undefined when the reply has no usable
 * answer. Tolerates a fenced or chatty reply, and a bare list of issue objects
 * from a model that dropped the wrapper. Entries without a `problem` are
 * dropped; an empty list is a valid, and the usual, answer.
 */
export function parseReviewIssues(text: string): ReviewIssue[] | undefined {
	const objects = extractJsonObjects(text)
	const wrapper = objects.find((parsed) => Array.isArray(parsed.issues))
	const candidates = wrapper ? (wrapper.issues as unknown[]) : objects.filter((parsed) => typeof parsed.problem === "string")
	if (!wrapper && candidates.length === 0) {
		return undefined
	}
	return candidates
		.map(toIssue)
		.filter((issue): issue is ReviewIssue => issue !== undefined)
		.slice(0, REVIEW_MAX_ISSUES)
}

/** Ask the reviewer. Resolves within `timeoutMs`; never throws. */
export async function runReviewer(options: {
	model: AgentModel
	input: ReviewInput
	timeoutMs: number
	/** The run's abort signal: a cancelled run stops the review. */
	signal?: AbortSignal
}): Promise<{ issues?: ReviewIssue[]; error?: string; raw?: string }> {
	const result = await collectModelText({
		model: options.model,
		buildRequest: (signal) => buildReviewRequest(options.input, signal),
		timeoutMs: options.timeoutMs,
		...(options.signal ? { parentSignal: options.signal } : {}),
	})
	const raw = result.text?.slice(0, 300)
	if (result.error) {
		return { error: result.error, ...(raw ? { raw } : {}) }
	}
	const issues = parseReviewIssues(result.text ?? "")
	return issues
		? { issues }
		: { error: `unusable reply: ${(result.text ?? "").slice(0, 80) || "(empty)"}`, ...(raw ? { raw } : {}) }
}

/** The reminder that hands the reviewer's findings back to the working model. */
export function reviewNudge(issues: readonly ReviewIssue[], reviewer: string): string {
	const items = issues.map((issue, index) => {
		const where = issue.file ? `${issue.file}${issue.line ? `:${issue.line}` : ""}: ` : ""
		return `${index + 1}. ${where}${issue.problem}${issue.why ? ` (${issue.why})` : ""}`
	})
	return [
		`${REVIEW_NUDGE_PREFIX} another model (${reviewer}) read the diff of what you changed this turn and flagged ` +
			`${issues.length} possible problem${issues.length === 1 ? "" : "s"}:`,
		...items,
		"The reviewer saw only the diff and can be wrong. Check each item against the code. Fix the ones that are " +
			"real, with tool calls, now. Then give your final reply, and say in it which items you dismissed and why. " +
			"Do not ask the user whether to fix them.",
	].join("\n")
}

function isReviewNudge(message: AgentMessage): boolean {
	return message.role === "user" && replyText(message).startsWith(REVIEW_NUDGE_PREFIX)
}

async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs)
			}),
		])
	} finally {
		if (timer) {
			clearTimeout(timer)
		}
	}
}

export interface ReviewPassOptions {
	/** Whether the run is one the pass applies to at all (a routed model is selected). */
	isActive: () => boolean
	/** `plinycode.review.beforeFinish`, read per run so a change applies to the next one. */
	isEnabled: () => boolean
	/** Ask mode arrives here as "plan": neither edits code. */
	getMode: () => "plan" | "act"
	/**
	 * Whether the model that would get the findings is a free one. The review
	 * itself is free, but the round of checking it sets off is billed when a
	 * paid model (BalanceAuto) is answering, so there the pass stays out, as
	 * the completion guard does. Taken as true when not given.
	 */
	freeModelIsAnswering?: () => boolean
	/** The completion guard let this reply through only because it had run out of reminders. */
	guardGaveUp?: () => boolean
	/** The review already recorded for the current run, if any. */
	recorded: () => ReviewRecord | undefined
	record: (review: ReviewRecord) => void
	rules: () => RouterRules
	knownModels?: () => Record<string, ModelInfo> | undefined
	isHealthy: (modelId: string) => boolean
	/** Models that worked on this turn; the reviewer is never one of them. */
	authors: () => ReadonlySet<string>
	/** File edits sub-agents made this turn: the root transcript does not show them. */
	subAgentEdits?: () => number
	/** A gateway model for a concrete id; undefined before the first run built one. */
	createModel: (modelId: string) => AgentModel | undefined
	/**
	 * The run's changes, from the checkpoint taken when it started. Resolves to
	 * undefined when there is none (not a git repository, checkpoints off).
	 */
	loadCheckpointDiff?: () => Promise<
		{ cwd?: string; diffs: ReadonlyArray<{ filePath: string; leftContent: string; rightContent: string }> } | undefined
	>
	/** Workspace root, to shorten the paths of reconstructed edits. */
	cwd?: string
	/** A reviewer is about to be asked, e.g. to show a chat row while it reads. */
	onStart?: (info: { modelId: string; files: number; added: number; removed: number }) => void
	/** The reviewer answered, or failed to. */
	onResult?: (info: { modelId: string; record: ReviewRecord; issues: readonly ReviewIssue[]; raw?: string }) => void
	/** The reviewer's call failed outright (not a timeout, not a cancel), for model health. */
	onReviewerError?: (modelId: string, error: string) => void
	now?: () => number
	timeoutMs?: number
}

/**
 * The pass as a completion guard, to be consulted after the router's own:
 * a string keeps the run going with the reviewer's findings, undefined lets
 * it end.
 */
export function createReviewPass(options: ReviewPassOptions): CompletionGuard {
	const now = options.now ?? (() => Date.now())
	const timeoutMs = options.timeoutMs ?? REVIEW_TIMEOUT_MS

	const skip = (reason: ReviewSkipReason): undefined => {
		// A later skip (the reply after the fix-up) must not hide what the review found.
		const recorded = options.recorded()
		if (!recorded || recorded.outcome === "skipped") {
			options.record({ outcome: "skipped", reason })
		}
		return undefined
	}

	const loadChanges = async (
		turn: readonly AgentMessage[],
	): Promise<{ changes: ReviewFileChange[]; source: "checkpoint" | "tool-calls" }> => {
		if (options.loadCheckpointDiff) {
			const checkpoint = await within(
				options.loadCheckpointDiff().catch(() => undefined),
				CHECKPOINT_DIFF_TIMEOUT_MS,
			)
			const changes = checkpoint ? changesFromCheckpoint(checkpoint.diffs, checkpoint.cwd ?? options.cwd) : []
			// An empty comparison next to successful edits means they went to
			// files the checkpoint does not track (git-ignored ones).
			if (changes.length > 0) {
				return { changes, source: "checkpoint" }
			}
		}
		return { changes: changesFromToolCalls(turn, options.cwd), source: "tool-calls" }
	}

	return async ({ message, runMessages, messages, signal }) => {
		if (!options.isActive()) {
			return undefined
		}
		const turn = currentTurnMessages(messages, runMessages)
		const recorded = options.recorded()
		if ((recorded && recorded.outcome !== "skipped") || turn.some(isReviewNudge)) {
			return skip("already-reviewed")
		}
		if (!options.isEnabled()) {
			return skip("setting-off")
		}
		if (options.getMode() !== "act") {
			return skip("not-act-mode")
		}
		if (options.freeModelIsAnswering?.() === false) {
			return skip("paid-model")
		}
		if (options.guardGaveUp?.()) {
			return skip("guard-gave-up")
		}
		if (countSuccessfulEdits(turn) + (options.subAgentEdits?.() ?? 0) === 0) {
			return skip("no-changes")
		}

		const knownModels = options.knownModels?.()
		const reviewer = pickReviewer({
			rules: options.rules(),
			authors: options.authors(),
			isHealthy: options.isHealthy,
			...(knownModels ? { knownModels } : {}),
		})
		const model = reviewer ? options.createModel(reviewer) : undefined
		if (!reviewer || !model) {
			return skip("no-reviewer")
		}

		const { changes, source } = await loadChanges(turn)
		const assessed = assessChanges(changes)
		if (assessed.skip) {
			return skip(assessed.skip)
		}
		if (signal?.aborted) {
			return skip("cancelled")
		}
		const diff = buildReviewDiff(assessed.reviewable, assessed.namedOnly)
		const truncated = diff.truncated.length > 0 || diff.omitted.length > 0
		const shown = { files: assessed.reviewable.length, added: assessed.added, removed: assessed.removed }

		options.onStart?.({ modelId: reviewer, ...shown })
		const startedAt = now()
		const result = await runReviewer({
			model,
			input: {
				userRequest: latestUserRequest(messages ?? runMessages),
				finalReply: replyText(message),
				diff: diff.text,
				...shown,
				...(truncated ? { truncated } : {}),
			},
			timeoutMs,
			...(signal ? { signal } : {}),
		})
		const base = {
			model: reviewer,
			durationMs: now() - startedAt,
			source,
			files: shown.files,
			...(truncated ? { truncated } : {}),
		}
		if (signal?.aborted) {
			options.record({ ...base, outcome: "skipped", reason: "cancelled" })
			return undefined
		}
		const issues = result.issues ?? []
		const record: ReviewRecord = result.error
			? { ...base, outcome: "no-verdict", reason: result.error.slice(0, 200) }
			: { ...base, outcome: issues.length > 0 ? "issues" : "clean", issues: issues.length }
		options.record(record)
		if (result.error && !result.error.startsWith("timed out") && !result.error.startsWith("unusable reply")) {
			options.onReviewerError?.(reviewer, result.error)
		}
		options.onResult?.({ modelId: reviewer, record, issues, ...(result.raw ? { raw: result.raw } : {}) })
		// The pool prefix says nothing to the model; the name is enough.
		return issues.length > 0 ? reviewNudge(issues, reviewer.slice(reviewer.indexOf("/") + 1)) : undefined
	}
}
