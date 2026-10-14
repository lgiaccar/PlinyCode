/**
 * The CI board: pull requests and branches the user watches together, each
 * with one status per pipeline, and prompts ("actions") to run against them.
 * No `vscode` import, so the board's logic runs in bun unit tests.
 */
import type { MergeState, PullRequest, Status } from "../server/providers/types"
import type { ProviderKind } from "../server/repo"

/** One pull request (`pr`), a branch's open PR or head (`branch`), or every open PR of a repository (`repo`). */
export type CiTargetKind = "pr" | "branch" | "repo"

/** The board's own actions. Every target has one of each; their prompt can be overridden. */
export type CiBuiltinId = "fix-conflicts" | "fix-build" | "recalibrate" | "fix-ci" | "investigate"

export const BUILTIN_IDS: readonly CiBuiltinId[] = ["fix-conflicts", "fix-build", "recalibrate", "fix-ci", "investigate"]

export const isBuiltinId = (id: string): id is CiBuiltinId => (BUILTIN_IDS as readonly string[]).includes(id)

export type CiPromptSource =
	| { kind: "builtin"; id: CiBuiltinId }
	| { kind: "file"; path: string }
	| { kind: "text"; text: string }

/** `free` runs on the free auto-router (`pliny/auto-free`); `current` on the model selected in the chat. */
export type CiModelChoice = "free" | "current"

/** When an action is the row's main button: on conflicts, on small test deltas, on other failures, or never by itself. */
export type CiSituation = "conflict" | "small-delta" | "failure" | "any"

/** A prompt the user can run against an item of the board. */
export interface CiAction {
	id: string
	label: string
	prompt: CiPromptSource
	model: CiModelChoice
	situation: CiSituation
	/** Auto-watch may start it on its own. Only honoured for `fix-conflicts` and `recalibrate`. */
	auto: boolean
}

export interface CiTarget {
	id: string
	kind: CiTargetKind
	/** The repository's git remote URL, or the repository part of a pasted PR link. */
	remoteUrl: string
	provider: ProviderKind
	/** A local checkout of the repository, when one is known. */
	repoRoot?: string
	/** `branch` targets. */
	branch?: string
	/** `pr` targets. */
	prId?: number
	/** `repo` targets: the signed-in user's PRs, or everyone's. */
	prFilter?: "mine" | "all"
	/** Fix conflicts and recalibrate small test deltas automatically, in the background. */
	autoWatch: boolean
	actions: CiAction[]
	createdTs: number
}

export type CiColor = "green" | "red" | "yellow" | "grey"

export interface CiPipelineStatus {
	/** The workflow or pipeline definition. */
	name: string
	color: CiColor
	/** Undefined for a pipeline seen on an earlier commit that has no run on this one. */
	status?: Status
	result?: string
	runId?: number
	url?: string
}

export interface CiBoardItem {
	/** Stable across targets: the same PR listed by two targets shares its key (and its conversation). */
	key: string
	pr?: PullRequest
	branch: string
	headSha?: string
	mergeState?: MergeState
	pipelines: CiPipelineStatus[]
	fork: boolean
	error?: string
}

/** The conversation an action started for an item. */
export interface CiLink {
	conversationId: string
	actionId: string
	/** Where the conversation works: a worktree, or the checkout itself. */
	worktree: string
	headSha?: string
	startedTs: number
	/** Started by auto-watch rather than by a click. */
	auto?: boolean
	/** The model the run is pinned to, when it is not the chat's. */
	modelId?: string
	/** The branch the run may push to. */
	sourceBranch?: string
	/** The git remote the run pushes to. */
	remoteName?: string
	/** The one pipeline the run was asked to fix, when it was scoped to one. */
	pipeline?: string
}

/** How often auto-watch started an action for an item. Keyed `item|action|headSha`, or `item|action` for the streak. */
export interface CiAutoAttempt {
	key: string
	count: number
	lastTs: number
}

/** How bad an item's failures are, worst first. */
export type CiSeverity = "blocker" | "high" | "medium" | "low" | "info"

/** What kind of failure a pipeline has. */
export type CiCategory = "conflict" | "build" | "test-regression" | "small-test-delta" | "infrastructure" | "stale" | "unknown"

export interface CiStepDetail {
	job: string
	step: string
	errors: string[]
	/** The log lines around the error, trimmed. */
	excerpt?: string
}

export interface CiPipelineTriage {
	name: string
	runId?: number
	url?: string
	category: CiCategory
	summary: string
	/** Empty once reloaded from disk: details are refetched on demand. */
	steps: CiStepDetail[]
}

/** What the board worked out about an item's failures. */
export interface CiTriageResult {
	/** The item's state this result is about; see `fingerprintOf`. */
	fingerprint: string
	itemKey: string
	headSha?: string
	/** `pending` while it runs; `deferred` when the rate limit is low and only names were used. */
	status: "pending" | "done" | "deferred"
	severity: CiSeverity
	summary: string
	pipelines: CiPipelineTriage[]
	conflict: boolean
	/** The built-in actions that fit, best first. */
	recommended: CiBuiltinId[]
	/** `model`: a free model classified the failures; `heuristic`: rules did, from names and error text. */
	source: "model" | "heuristic"
	/** How sure the model is that every failure is a small test delta, 0–1. */
	smallDeltaConfidence?: number
	/** The full markdown report, when the details did not fit the board. */
	reportPath?: string
	analyzedTs: number
	error?: string
}

export interface CiTransition {
	targetId: string
	itemKey: string
	kind: "failed" | "conflict" | "recovered"
	/** The pipelines that turned red, for `failed`. */
	pipelines: string[]
	headSha?: string
}

/** The fix-ci action's name. It was "Fix CI" before the board offered a fix per pipeline. */
export const FIX_ALL_LABEL = "Fix them all"

export const BUILTIN_ACTIONS: readonly CiAction[] = [
	{
		id: "fix-conflicts",
		label: "Fix conflicts",
		prompt: { kind: "builtin", id: "fix-conflicts" },
		model: "free",
		situation: "conflict",
		auto: true,
	},
	{
		// The main button of a single failed pipeline; see `ci-board-actions.ts`.
		id: "fix-build",
		label: "Fix build",
		prompt: { kind: "builtin", id: "fix-build" },
		model: "free",
		situation: "any",
		auto: false,
	},
	{
		id: "recalibrate",
		label: "Recalibrate",
		prompt: { kind: "builtin", id: "recalibrate" },
		model: "free",
		situation: "small-delta",
		auto: true,
	},
	{
		id: "fix-ci",
		label: FIX_ALL_LABEL,
		prompt: { kind: "builtin", id: "fix-ci" },
		model: "free",
		situation: "failure",
		auto: false,
	},
	{
		id: "investigate",
		label: "Investigate",
		prompt: { kind: "builtin", id: "investigate" },
		model: "free",
		situation: "failure",
		auto: false,
	},
]

export const defaultActions = (): CiAction[] => BUILTIN_ACTIONS.map((a) => ({ ...a, prompt: { ...a.prompt } }))

/**
 * Puts the built-in actions first, in their fixed order, keeping any edits the
 * user made to them, and adds the ones that are missing. Custom actions follow.
 */
export function withBuiltins(actions: CiAction[]): CiAction[] {
	const builtins = BUILTIN_ACTIONS.map((b) => {
		const own = actions.find((a) => a.id === b.id)
		return own ? { ...own, situation: b.situation, auto: b.auto && own.auto } : { ...b, prompt: { ...b.prompt } }
	})
	return [...builtins, ...actions.filter((a) => !isBuiltinId(a.id))]
}
