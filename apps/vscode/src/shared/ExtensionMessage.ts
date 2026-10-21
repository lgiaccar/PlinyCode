// type that represents json data that is sent from extension to webview, called ExtensionMessage and has 'type' enum which can be 'plusButtonClicked' or 'settingsButtonClicked' or 'hello'

import type { GeneratedMedia } from "@plinycode/shared"
import { WorkspaceRoot } from "@shared/multi-root/types"
import type { Environment } from "../config"
import { AutoApprovalSettings } from "./AutoApprovalSettings"
import { ApiConfiguration } from "./api"
import { ClineRulesToggles } from "./cline-rules"
import { HistoryItem } from "./HistoryItem"
import { McpDisplayMode } from "./McpDisplayMode"
import { ClineMessageModelInfo } from "./messages"
import type { ModelTuningMap } from "./model-tuning"
import type { PlanExecutionChoice } from "./planExecution"
import type { RouterTuningMap } from "./router-tuning"
import { Mode } from "./storage/types"
import type { WorkspaceRef } from "./workspaceRef"
// webview will hold state
export interface ExtensionMessage {
	type: "grpc_response" // New type for gRPC responses
	grpc_response?: GrpcResponse
}

export type GrpcResponse = {
	message?: any // JSON serialized protobuf message
	request_id: string // Same ID as the request
	error?: string // Optional error message
	is_streaming?: boolean // Whether this is part of a streaming response
	sequence_number?: number // For ordering chunks in streaming responses
}

export type Platform = "aix" | "darwin" | "freebsd" | "linux" | "openbsd" | "sunos" | "win32" | "unknown"

export const DEFAULT_PLATFORM = "unknown"

export interface ExtensionState {
	welcomeViewCompleted: boolean
	apiConfiguration?: ApiConfiguration
	autoApprovalSettings: AutoApprovalSettings
	preferredLanguage?: string
	mode: Mode
	clineMessages: ClineMessage[]
	checkpointRestoreInput?: {
		text: string
		images?: string[]
		files?: string[]
		sessionId: string
	}
	/** Scroll/focus the chat after edit-and-restart supersedes the active session. */
	editMessageRestartFocus?: {
		messageTs: number
		sessionId: string
	}
	/**
	 * The single authoritative UI mode for the current turn, owned by the extension. The webview
	 * renders the footer/buttons/thinking indicator from this, NOT from the tail of clineMessages.
	 * Optional for classic/legacy (absent => webview falls back to legacy tail heuristics).
	 */
	turnState?: TurnState
	/**
	 * Follow-up prompts submitted while the active agent turn is still running.
	 * These are owned by the SDK pending-prompt queue and are sent after the
	 * current turn reaches a safe continuation point.
	 */
	queuedPrompts?: QueuedPrompt[]
	/**
	 * Monotonic version of this state snapshot. The webview applies a snapshot only if its
	 * stateVersion is newer than the last applied, so stale/out-of-order state pushes are
	 * ignored. Stamped by the extension. Optional for classic/legacy.
	 */
	stateVersion?: number
	/**
	 * Conversation/replica fence for this snapshot (see ClineMessage.epoch). A snapshot with a
	 * newer epoch replaces the webview transcript; an older one is dropped; an equal one merges.
	 * Optional for classic/legacy.
	 */
	epoch?: number
	currentTaskItem?: HistoryItem
	mcpDisplayMode: McpDisplayMode
	planActSeparateModelsSetting: boolean
	enableCheckpointsSetting?: boolean
	platform: Platform
	environment?: Environment
	taskHistory: HistoryItem[]
	shellIntegrationTimeout: number
	terminalReuseEnabled?: boolean
	defaultTerminalProfile?: string
	vscodeTerminalExecutionMode: string
	backgroundCommandRunning?: boolean
	backgroundCommandTaskId?: string
	/**
	 * True while a foreground (VS Code terminal) command is awaited by a
	 * run_commands tool call. Drives the "Proceed While Running" button.
	 */
	foregroundCommandRunning?: boolean
	/**
	 * Tasks still running in the background after the user started or opened
	 * another task. `needs_attention`: waiting for an approval or an answer.
	 */
	backgroundTasks?: { id: string; status: "running" | "needs_attention" }[]
	lastCompletedCommandTs?: number
	version: string
	distinctId: string
	globalClineRulesToggles: ClineRulesToggles
	localClineRulesToggles: ClineRulesToggles
	localWorkflowToggles: ClineRulesToggles
	globalWorkflowToggles: ClineRulesToggles
	localCursorRulesToggles: ClineRulesToggles
	localWindsurfRulesToggles: ClineRulesToggles
	localAgentsRulesToggles: ClineRulesToggles
	localCopilotRulesToggles: ClineRulesToggles
	mcpResponsesCollapsed?: boolean
	chatInputMaxRows?: number
	useAutoCondense?: boolean
	compactionStrategy?: string
	/** `plinycode.compaction.threshold`: auto-condense runs at this share of the model's input limit (0.1 to 0.95). */
	compactionThreshold?: number
	webSearchEnabled?: boolean
	/** `plinycode.updates.prerelease`: the auto-updater also installs pre-releases. */
	prereleaseUpdatesEnabled?: boolean
	/** `plinycode.spending.conversationLimit`: the budget new conversations start with, in USD; 0 = no limit. */
	conversationSpendingLimit?: number
	/** `plinycode.memory.maxTokens`: the memory budget in the system prompt; 0 = memory off (docs/memory.md). */
	memoryMaxTokens?: number
	/** `plinycode.memory.distill` is "offer": memories are proposed after a run that edited files. */
	memoryDistillEnabled?: boolean
	/** `plinycode.memory.conversationSearch`: the model can search and read earlier conversations. */
	memoryConversationSearchEnabled?: boolean
	/** `plinycode.plan.executeWith`: the model the Execute plan button runs a plan on; the last choice made in its menu. */
	planExecutionChoice?: PlanExecutionChoice
	subagentsEnabled?: boolean
	favoritedModelIds: string[]
	/** Per-model reasoning and context tuning, keyed by model id (src/shared/model-tuning.ts). */
	modelTuning?: ModelTuningMap
	/** Settings → Router, per router profile (src/shared/router-tuning.ts): the context bar reads its compaction budget. */
	routerTuning?: RouterTuningMap
	/**
	 * The workspace this window is open on (folder, or .code-workspace file for
	 * multi-folder workspaces). New conversations bind to it unless another one
	 * is picked, and history shows its conversations by default. Unset when no
	 * folder is open.
	 */
	currentWorkspace?: WorkspaceRef
	// NEW: Add workspace information
	workspaceRoots: WorkspaceRoot[]
	primaryRootIndex: number
	isMultiRootWorkspace: boolean
	hooksEnabled?: boolean
	globalSkillsToggles?: Record<string, boolean>
	localSkillsToggles?: Record<string, boolean>
	backgroundEditEnabled?: boolean
	showFeatureTips?: boolean
}

/**
 * The authoritative UI mode for the current agent turn, owned by the extension. The webview reads
 * this instead of inferring mode from the tail of clineMessages.
 */
export type TurnPhase =
	| "idle" // no active turn; input enabled, no buttons
	| "streaming" // model producing content / tool running; Thinking + Cancel
	| "awaiting_approval" // a tool/command/mcp/subagent approval is pending
	| "awaiting_followup" // ask_question / plan_mode_respond / done-without-completion
	| "completed" // attempt_completion done; Start New Task
	| "error" // api_req_failed / fatal; Retry / recovery
	| "resumable" // task cancelled / interrupted; Resume Task

export interface TurnState {
	phase: TurnPhase
	/** ts of the ClineMessage this phase is "about" (e.g. the pending approval/ask). */
	anchorTs?: number
	/** Monotonic; the webview keeps the highest-seq TurnState and ignores older ones. */
	seq: number
}

export interface QueuedPrompt {
	id: string
	prompt: string
	delivery: "queue" | "steer"
	attachmentCount: number
}

export interface ClineMessage {
	ts: number
	type: "ask" | "say"
	ask?: ClineAsk
	say?: ClineSay
	text?: string
	reasoning?: string
	images?: string[]
	media?: GeneratedMedia[]
	files?: string[]
	partial?: boolean
	/**
	 * Freshness counter for convergent-replica merging on the webview side. Monotonically
	 * increasing per process; a higher `seq` means a newer copy of the SAME `ts` (identity).
	 * Stamped by the extension as the message flows to the webview. Optional for classic/legacy.
	 */
	seq?: number
	/**
	 * Conversation/replica fence. Messages from an older epoch (a previous task or a previous
	 * render of the same task) are dropped by the webview. Stamped by the extension. Optional
	 * for classic/legacy.
	 */
	epoch?: number
	commandCompleted?: boolean
	lastCheckpointHash?: string
	isCheckpointCheckedOut?: boolean
	isOperationOutsideWorkspace?: boolean
	conversationHistoryIndex?: number
	conversationHistoryDeletedRange?: [number, number] // for when conversation history is truncated for API requests
	modelInfo?: ClineMessageModelInfo
	/**
	 * A user message asked as an off-the-record side question: it and its answer are left
	 * out of later model requests (docs/side-questions.md).
	 */
	offTheRecord?: boolean
	/**
	 * A user message that answered the agent's question, or the feedback given with a rejected
	 * tool. The conversation stores it as a tool result, not as a user message, so it neither
	 * starts a checkpoint run nor counts when chat rows are mapped onto the conversation.
	 */
	answersTool?: boolean
}

export type ClineAsk =
	| "followup"
	| "plan_mode_respond"
	| "act_mode_respond"
	| "command"
	| "command_output"
	| "completion_result"
	| "tool"
	| "api_req_failed"
	| "resume_task"
	| "resume_completed_task"
	| "mistake_limit_reached"
	| "browser_action_launch"
	| "use_mcp_server"
	| "new_task"
	| "condense"
	| "summarize_task"
	| "report_bug"
	| "use_subagents"

export type ClineSay =
	| "task"
	| "error"
	| "api_req_started"
	| "api_req_finished"
	| "text"
	| "reasoning"
	| "completion_result"
	| "plan_completion_result" // turn-final plan-mode response inferred at turn end (SDK path)
	| "user_feedback"
	| "user_feedback_diff"
	| "command"
	| "command_output"
	| "tool"
	| "shell_integration_warning"
	| "shell_integration_warning_with_suggestion"
	| "browser_action_launch"
	| "browser_action"
	| "browser_action_result"
	| "mcp_server_request_started"
	| "mcp_server_response"
	| "mcp_notification"
	| "use_mcp_server"
	| "diff_error"
	| "deleted_api_reqs"
	| "clineignore_error"
	| "command_permission_denied"
	| "checkpoint_created"
	| "load_mcp_documentation"
	| "info" // Added for general informational messages like retry status
	| "task_progress"
	| "hook_status"
	| "hook_output_stream"
	| "subagent"
	| "use_subagents"
	| "subagent_usage"
	| "conditional_rules_applied"
	| "compaction" // context compaction progress/result divider
	| "memory_proposal" // memories offered for saving (JSON MemoryProposal, @shared/memory-proposal)

export interface ClineSayTool {
	tool:
		| "editedExistingFile"
		| "newFileCreated"
		| "fileDeleted"
		| "readFile"
		| "listFilesTopLevel"
		| "listFilesRecursive"
		| "listCodeDefinitionNames"
		| "searchFiles"
		| "webFetch"
		| "webSearch"
		| "summarizeTask"
		| "useSkill"
		| "saveMemory"
		| "searchConversations"
		| "readConversation"
		| "findSymbol"
		| "codeNavigate"
		| "renamePreview"
		| "renameSymbol"
		| "processList"
		| "processOutput"
		| "processKill"
	path?: string
	diff?: string
	content?: string
	regex?: string
	/** code_navigate: `definition`, `references`, `hover`, `callers`, `callees` or `diagnostics`. */
	action?: string
	/** rename_preview and rename_symbol: the name the symbol (in `regex`) gets. */
	newName?: string
	filePattern?: string
	operationIsLocatedInWorkspace?: boolean
	/** Starting line numbers in the original file where each SEARCH block matched */
	startLineNumbers?: number[]
	/** One-based inclusive line range requested by read_file; readLineEnd omitted = open-ended read (for UI summaries). */
	readLineStart?: number
	readLineEnd?: number
}

// The browser tool was removed; these shapes remain so old conversations still render.
export interface ClineSayBrowserAction {
	action: "launch" | "click" | "type" | "scroll_down" | "scroll_up" | "close"
	coordinate?: string
	text?: string
}

export type SubagentExecutionStatus = "pending" | "running" | "completed" | "failed"

export interface SubagentStatusItem {
	index: number
	prompt: string
	status: SubagentExecutionStatus
	/** The engine's id of the sub-agent, once it has started; approvals it asks for name it. */
	agentId?: string
	cacheReadTokens?: number
	cacheWriteTokens?: number
	toolCalls: number
	inputTokens: number
	outputTokens: number
	totalCost: number
	contextTokens: number
	contextWindow: number
	contextUsagePercentage: number
	latestToolCall?: string
	result?: string
	error?: string
}

export interface ClineSaySubagentStatus {
	status: "running" | "completed" | "failed"
	total: number
	completed: number
	successes: number
	failures: number
	toolCalls: number
	inputTokens: number
	outputTokens: number
	contextWindow: number
	maxContextTokens: number
	maxContextUsagePercentage: number
	items: SubagentStatusItem[]
}

export type BrowserActionResult = {
	screenshot?: string
	logs?: string
	currentUrl?: string
	currentMousePosition?: string
}

export interface ClineAskUseMcpServer {
	serverName: string
	type: "use_mcp_tool" | "access_mcp_resource"
	toolName?: string
	arguments?: string
	uri?: string
	/** The tool's description, for built-in servers the webview's MCP server list does not include. */
	description?: string
}

export interface ClineAskUseSubagents {
	prompts: string[]
}

export interface ClinePlanModeResponse {
	response: string
	options?: string[]
	selected?: string
}

export interface ClineAskQuestion {
	question: string
	options?: string[]
	selected?: string
}

/**
 * Where the current request's context tokens came from. Each field is a
 * token-estimate count (same estimator as the rest of the context-window
 * bar), scaled so the sum matches the provider-reported prompt size when one
 * is available. Absent/zero sections are omitted rather than sent as 0.
 */
export interface ClineContextBreakdown {
	systemPrompt?: number
	rules?: number
	/** The `# Memory` section of the system prompt (docs/memory.md). */
	memory?: number
	/** The tool definitions sent with the request: names, descriptions and input schemas. */
	tools?: number
	/** The skills tool's listing and results, and skill bodies pasted by a slash command. */
	skills?: number
	/** Workflow bodies pasted by a slash command. */
	workflows?: number
	conversation?: number
	other?: number
}

export interface ClineApiReqInfo {
	request?: string
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
	cancelReason?: ClineApiReqCancelReason
	streamingFailedMessage?: string
	/** True when tokensIn/tokensOut are a char-based estimate, not provider-reported figures. */
	estimated?: boolean
	/** Breakdown of this request's context tokens by source; see ContextWindowSummary. */
	contextBreakdown?: ClineContextBreakdown
	/** Hidden reasoning tokens, when the provider reports them. Already counted in tokensOut. */
	reasoningTokens?: number
	/** The model that served this request: the routed model for FreeAuto/BalanceAuto, else the selected one. */
	modelId?: string
	/**
	 * The request's whole input as last sent, cache included: what the context
	 * bar shows. Differs from tokensIn + cache when a retried empty reply billed
	 * the same request twice. Absent on rows written before 0.2.5.
	 */
	contextTokens?: number
	/**
	 * Tokens the engine left out of this request before sending it: old tool
	 * output, earlier reasoning, superseded file reads, side questions. Why the
	 * context can shrink between calls without a compaction.
	 */
	prunedTokens?: number
}

/**
 * JSON payload of a say:"compaction" message. Mirrors the CLI's compaction
 * divider (apps/cli/src/tui/utils/compaction-status.ts): a "started" row shows
 * a spinner and is later updated in place (same ts) to its terminal status.
 */
export interface ClineCompactionInfo {
	status: "started" | "completed" | "skipped" | "failed" | "cancelled"
	/** overflow: the provider rejected the request as too large, and the history was compacted to retry it. */
	mode: "auto" | "manual" | "overflow"
	tokensBefore?: number
	tokensAfter?: number
	messagesBefore?: number
	messagesAfter?: number
	/** agentic, basic or custom. */
	strategy?: string
	/**
	 * The summary the model continues from, for the row to show (capped). The row
	 * itself never reaches the model: only the summary message in its history does.
	 */
	summary?: string
}

export interface ClineSubagentUsageInfo {
	/**
	 * Whose usage the row adds to the conversation's: a sub-agent batch, one
	 * advisor call (`ask_advisor`), the model call that summarized the
	 * context during compaction, or one image the router had described for a
	 * model that cannot see images (`plinycode.router.images`).
	 */
	source: "subagents" | "advisor" | "compaction" | "vision"
	tokensIn: number
	tokensOut: number
	cacheWrites: number
	cacheReads: number
	cost: number
	/** True when the figures were estimated rather than reported by the provider. */
	estimated?: boolean
}

type ClineApiReqCancelReason = "streaming_failed" | "user_cancelled" | "retries_exhausted"

export const COMPLETION_RESULT_CHANGES_FLAG = "HAS_CHANGES"
