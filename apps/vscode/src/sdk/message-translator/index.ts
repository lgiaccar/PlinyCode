// Replaces classic message streaming from src/core/task/index.ts (see origin/main)
//
// Translates SDK session events into ClineMessage[] for webview consumption.
// The webview expects ClineMessage objects with ask/say types; this module
// maps SDK CoreSessionEvent and AgentEvent types to that format.
//
// Key mappings:
// - SDK "chunk" event (agent stream) → ClineMessage say="text" with partial=true
// - SDK "agent_event" content_start (text) → ClineMessage say="text" with partial=true
// - SDK "agent_event" content_start (reasoning) → ClineMessage say="reasoning" with partial=true
// - SDK "agent_event" content_start (tool) → ClineMessage say="tool" with partial=true
//   IMPORTANT: The webview's ChatRow.tsx parses message.text as JSON when
//   say==="tool", expecting ClineSayTool format: {tool, path, content, ...}.
//   We must convert SDK tool names (read_files, editor, run_commands, etc.)
//   and their inputs to this format.
// - SDK "agent_event" content_start (tool: MCP) → ClineMessage say="use_mcp_server" with partial=true
//   MCP tools use serverName__toolName naming convention. The webview renders
//   MCP tool calls via say/ask="use_mcp_server" with ClineAskUseMcpServer JSON.
// - SDK "agent_event" content_end (tool: MCP) → say="use_mcp_server" + say="mcp_server_response"
// - SDK "agent_event" content_end → ClineMessage with partial=false
// - SDK "agent_event" content_start (tool: attempt_completion) → ClineMessage say="completion_result"
// - SDK "agent_event" content_end (tool: attempt_completion) → ClineMessage say="completion_result" (final)
// - SDK "agent_event" done (reason "completed", turn ended on text) → retags that final
//   say="text" row in place to say="completion_result" (act) / say="plan_completion_result" (plan)
// - SDK "agent_event" error → ClineMessage say="error"
// - SDK "agent_event" usage → ClineMessage say="api_req_started" with ClineApiReqInfo JSON
// - SDK "ended" event → finalizes the session
//
// This module used to be a single ~2800-line file (message-translator.ts). It
// is now split into focused files, re-exported here so every existing import
// of "./message-translator" (or "../message-translator", etc.) keeps working
// unchanged:
//   - translator-state.ts   — TranslationResult, normalizeUsageEvent, MessageTranslatorState
//   - tool-input-parse.ts   — pure tool-input parsing helpers
//   - tool-mapping.ts        — SDK tool name → ClineSayTool mapping, MCP tool detection
//   - ask-builders.ts        — tool-approval ask message + compaction notice helpers
//   - live-events.ts         — translateAgentEvent, translateSessionEvent
//   - history-replay.ts      — sdkMessagesToClineMessages (persisted history)
//   - error-reshape.ts       — reshapeErrorForWebview

export { buildCompactionMessage, buildToolApprovalAskMessage, parseCompactionNoticeMetadata } from "./ask-builders"
export { reshapeErrorForWebview } from "./error-reshape"
export type { SdkMessagesToClineMessagesOptions } from "./history-replay"
export { sdkMessagesToClineMessages } from "./history-replay"

export { translateSessionEvent } from "./live-events"
export { extractToolOutputText } from "./tool-mapping"
export type { TranslationResult } from "./translator-state"
export { MessageTranslatorState, normalizeUsageEvent } from "./translator-state"
