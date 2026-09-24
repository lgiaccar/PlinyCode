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
	conversationHistoryDeletedRange?: [number, number]
	isFavorited?: boolean

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
	 * Transient, never persisted: when the current turn started running (ms since
	 * epoch). Set only on the webview's `currentTaskItem` while a turn runs, so the
	 * task header can tick the running time live.
	 */
	runningSinceTs?: number
}
