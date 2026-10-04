import type { WorkspaceKind } from "./workspaceRef"

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
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean
	/** Pinned conversations are listed first in the history view, in their own section. */
	isPinned?: boolean

	modelId?: string
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
