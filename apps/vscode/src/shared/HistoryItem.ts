import type { WorkspaceKind } from "./workspaceRef"

/**
 * The git worktree a conversation started with "Run in worktree" works in
 * (docs/task-worktrees.md). Stored as `worktree` in the session metadata.
 */
export interface TaskWorktree {
	/** Top level of the checkout the worktree was branched from. */
	repoRoot: string
	/** The branch created for the conversation, e.g. `lgiaccar/fix-login-3f2a`. */
	branch: string
	/** The worktree's folder. */
	path: string
	/**
	 * The workspace the user started the conversation from. The conversation is
	 * bound to the worktree, and history filtered by this workspace lists it too.
	 */
	sourceWorkspacePath?: string
	/**
	 * The commit the branch was created from. "Apply" brings over the changes
	 * since this commit; absent for worktrees made before it was recorded, which
	 * fall back to the merge base with the source checkout's `HEAD`.
	 */
	baseCommit?: string
	/** When the worktree was removed (Remove worktree, or the daily cleanup); the history stays. */
	removedTs?: number
}

export type HistoryItem = {
	id: string
	ulid?: string // ULID for better tracking and metrics
	ts: number
	task: string
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number

	size?: number
	cwdOnTaskInitialization?: string
	/** VS Code workspace root when the task started; used for history context when it differs from cwd. */
	workspaceRootOnTaskInitialization?: string
	/**
	 * Workspace the conversation is bound to: a folder path, or the
	 * .code-workspace file of a multi-folder workspace. Absent for conversations
	 * recorded before workspace binding, which are bound to their workspace root.
	 */
	workspacePath?: string
	workspaceKind?: WorkspaceKind
	/** Set when the conversation runs in a git worktree of its own ("Run in worktree"). */
	worktree?: TaskWorktree
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean
	/** Pinned conversations are listed first in the history view, in their own section. */
	isPinned?: boolean

	modelId?: string
	/**
	 * The model the conversation always runs on, whatever the chat selects (a
	 * CI board run pinned to the free auto-router). Absent for ordinary ones.
	 */
	pinnedModelId?: string
	/**
	 * Path to a custom agent file selected in the new-task UI. When set, the
	 * conversation runs under that agent's instructions. Absent for the generic
	 * agent. Persisted so the agent survives session rebuilds (mode change,
	 * compaction, resume, checkpoint restore), like pinnedModelId.
	 */
	agentPath?: string
	/**
	 * Provider id the task ran on (from the SDK session record). Absent for
	 * tasks recorded before this field existed and for legacy imports —
	 * cost-display consumers treat an absent provider as "show", since
	 * there is nothing to key suppression on.
	 */
	apiProvider?: string
	isLegacy?: boolean
	/** When the conversation started (ms since epoch); `ts` is the last activity. */
	startedTs?: number
	/** Accumulated time the agent spent running turns (ms). */
	activeMs?: number
	/** True once the user renamed the task, so regenerating from an edited first message keeps the title. */
	isRenamed?: boolean
	/**
	 * This conversation's budget in USD (0 = no limit). Absent until the user
	 * sets one or a budget stop raises it; until then the default
	 * `plinycode.spending.conversationLimit` applies. See sdk/spending-limit.ts.
	 */
	spendingLimit?: number
	/** Cumulative `wait` time allowed per agent turn, in minutes; 0 disables the limit. */
	waitMinutesPerTurn?: number
	/**
	 * How much a budget stop raises the budget: the amount the user last typed for this
	 * conversation. Absent until they set one; then the default budget is the step.
	 */
	spendingStep?: number
	/**
	 * Transient, never persisted: when the current turn started running (ms since
	 * epoch). Set only on the webview's `currentTaskItem` while a turn runs, so the
	 * task header can tick the running time live.
	 */
	runningSinceTs?: number
}
