/**
 * The CI board: pull requests and branches the user watches together, each
 * with one status per pipeline, and prompts ("actions") to run against them.
 * No `vscode` import, so the board's logic runs in bun unit tests.
 */
import type { MergeState, PullRequest, Status } from "../server/providers/types"
import type { ProviderKind } from "../server/repo"

/** One pull request (`pr`), a branch's open PR or head (`branch`), or every open PR of a repository (`repo`). */
export type CiTargetKind = "pr" | "branch" | "repo"

/**
 * What happens when CI turns red or the PR conflicts: `manual` notifies and
 * waits for a click, `auto` starts the action with the usual approvals, and
 * `full_auto` also approves its tool calls. Only `manual` runs today.
 */
export type CiAutonomy = "manual" | "auto" | "full_auto"

export type CiTrigger = "manual" | "on_failure" | "on_conflict" | "on_failure_or_conflict"

export type CiPromptSource = { kind: "builtin" } | { kind: "file"; path: string } | { kind: "text"; text: string }

/** A prompt the user can run against an item of the board. */
export interface CiAction {
	id: string
	label: string
	prompt: CiPromptSource
	trigger: CiTrigger
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
	autonomy: CiAutonomy
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
}

export interface CiTransition {
	targetId: string
	itemKey: string
	kind: "failed" | "conflict" | "recovered"
	/** The pipelines that turned red, for `failed`. */
	pipelines: string[]
	headSha?: string
}

export const DEFAULT_ACTIONS: CiAction[] = [
	{ id: "fix", label: "Fix CI & conflicts", prompt: { kind: "builtin" }, trigger: "on_failure_or_conflict" },
]
