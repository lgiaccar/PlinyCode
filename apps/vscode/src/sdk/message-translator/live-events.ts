// Live-streaming SDK event translation: translateAgentEvent (per-event-type
// switch) and translateSessionEvent (the top-level entry point). Split out of
// message-translator.ts (see message-translator/index.ts).

import type { CoreSessionEvent } from "@plinycode/core"
import type { AgentEvent } from "@plinycode/shared"
import { formatDisplayUserInput } from "@plinycode/shared"
import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type {
	ClineApiReqInfo,
	ClineAskUseSubagents,
	ClineMessage,
	ClineSay,
	ClineSaySubagentStatus,
	ClineSayTool,
	ClineSubagentUsageInfo,
} from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"
import { isSyntheticUserPrompt } from "../sdk-user-message-mapping"
import { isKnownToolApprovalDenial } from "../tool-approval-denial"
import { advisorQuestionMessage, advisorResultMessages, isAdvisorTool } from "./advisor-rows"
import { buildCompactionMessage, finalizeDanglingCompaction, parseCompactionNoticeMetadata } from "./ask-builders"
import { reshapeErrorForWebview } from "./error-reshape"
import {
	extractFileReads,
	getApplyPatchString,
	getStringField,
	parseToolInput,
	readLineRangeFields,
	splitApplyPatchByFile,
} from "./tool-input-parse"
import {
	buildMcpToolPayload,
	extractCommandText,
	extractToolOutputText,
	getCompletionResultText,
	isCompletionTool,
	parseMcpToolName,
	sdkToolToClineSayTool,
	toDisplaySayTool,
} from "./tool-mapping"
import type { MessageTranslatorState, TranslationResult } from "./translator-state"
import { normalizeUsageEvent } from "./translator-state"

// ---------------------------------------------------------------------------
// Agent event translation
// ---------------------------------------------------------------------------

/**
 * Status notices that are internal diagnostics with no user-facing copy — their
 * `message` is a slug, not prose. Only these are suppressed; an unlisted status
 * notice renders as an info row so it doesn't vanish silently. Keep in sync
 * with the `emitStatusNotice` call sites in
 * sdk/packages/core/src/extensions/context/compaction.ts (the compaction phase
 * slugs are handled above via parseCompactionNoticeMetadata instead).
 */
const INTERNAL_STATUS_NOTICES = new Set(["compaction-budget-adjusted"])

/**
 * Translate an SDK AgentEvent into ClineMessage(s).
 */
function translateAgentEvent(event: AgentEvent, state: MessageTranslatorState): ClineMessage[] {
	const messages: ClineMessage[] = []

	switch (event.type) {
		case "content_start": {
			switch (event.contentType) {
				case "text": {
					// The SDK emits MULTIPLE content_start events for streaming text.
					// Each has `text` (the delta) and `accumulated` (full text so far).
					// We use `accumulated` so the webview can update the message in-place
					// with the growing text, giving smooth streaming. Using `text` (delta)
					// would cause a "flip book" effect where each update replaces the
					// previous content with just the new chunk.
					const ts = state.getStreamingTextTs()
					messages.push({
						ts,
						type: "say",
						say: "text",
						text: event.accumulated ?? event.text ?? "",
						partial: true,
					})
					break
				}
				case "reasoning": {
					// SDK reasoning content_start events are deltas. The webview renders
					// reasoning from `text`, so keep `text` and `reasoning` populated with
					// the accumulated content for smooth in-place streaming.
					const ts = state.getStreamingReasoningTs()
					const reasoning = state.appendStreamingReasoning(event.reasoning ?? "")
					messages.push({
						ts,
						type: "say",
						say: "reasoning",
						text: reasoning,
						reasoning,
						partial: true,
					})
					break
				}
				case "tool": {
					const toolName = event.toolName ?? "unknown"
					const input = event.input

					// Tool activity after a text block means that text wasn't the
					// turn-final response — drop the retag candidate.
					state.clearTurnFinalText()

					if (state.isToolApprovalDenied(event.toolCallId)) {
						break
					}

					// Store tool context so content_end can use it
					// (content_end doesn't carry the input)
					state.setStreamingToolContext(toolName, event.toolCallId, input)
					const approvedToolMessageTs = state.consumeApprovedToolMessageTs(event.toolCallId)
					if (approvedToolMessageTs !== undefined) {
						state.setStreamingToolTs(approvedToolMessageTs)
					}

					// ask_question (and ask_followup_question) is NOT a visual tool row: the
					// SdkInteractionCoordinator services it and emits the proper ask:"followup"
					// message. Emitting a generic say:"tool" here would leave an orphan partial
					// row that never finalizes. Suppress it (the CLI does the same).
					if (toolName === "ask_question" || toolName === "ask_followup_question") {
						break
					}

					// The completion tool (attempt_completion / submit_and_exit) is handled specially:
					// it drives the green completion box. We emit say:"completion_result"
					// here (partial) and finalize it at content_end. Recording attemptCompletionSeen
					// makes the turn end in the "completed" phase ("Start New Task") rather than
					// "awaiting_followup".
					if (isCompletionTool(toolName)) {
						state.setAttemptCompletionSeen()
						const resultText = getCompletionResultText(input)
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "completion_result",
							text: resultText,
							partial: true,
						})
						break
					}

					// command tools use say="command" (not say="tool")
					// because the webview renders commands differently
					if (toolName === "run_commands" || toolName === "execute_command") {
						const commandText = extractCommandText(input)
						// ChatRow treats a command row as "executing" while the COMMAND_OUTPUT_STRING
						// marker is present in the text (and the row isn't yet completed). Include the
						// marker on the running row so it reflects the executing state. content_end
						// rebuilds the full text (command + marker + output) and sets commandCompleted.
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "command",
							text: `${commandText}\n${COMMAND_OUTPUT_STRING}`,
							partial: true,
						})
						break
					}
					// spawn_agent → rich subagent UI (SubagentStatusRow)
					// Emit say:"use_subagents" with prompts list, then say:"subagent"
					// with running status. Multiple parallel spawn_agent calls in the
					// same iteration are aggregated into a single status message.
					if (toolName === "spawn_agent") {
						const parsedInput = parseToolInput(input)
						const taskPrompt = getStringField(parsedInput, "task") ?? ""
						const callId = event.toolCallId ?? `spawn-${state.nextTs()}`
						state.addSpawnAgent(callId, taskPrompt)
						Logger.log(`[Subagent] spawned: ${taskPrompt.replace(/\s+/g, " ").slice(0, 120)}`)
						if (approvedToolMessageTs !== undefined) {
							state.setSpawnAgentPromptsTs(approvedToolMessageTs)
						}

						// Emit the combined prompts list (replaces itself on each new spawn_agent)
						const allPrompts = state.getSpawnAgentItems().map((e) => e.prompt)
						const approvalPayload: ClineAskUseSubagents = {
							prompts: allPrompts,
						}
						messages.push({
							ts: state.getSpawnAgentPromptsTs(),
							type: "say",
							say: "use_subagents" as ClineSay,
							text: JSON.stringify(approvalPayload),
							partial: true,
						})

						// Clear the generic streaming tool so it doesn't also emit say:"tool"
						state.clearStreamingTool()
						break
					}

					// ask_advisor → "asked the advisor" row with the question; content_end adds the advice.
					if (isAdvisorTool(toolName)) {
						messages.push(advisorQuestionMessage(input, state.getStreamingToolTs(), true))
						break
					}

					// MCP tools use serverName__toolName naming convention.
					// The webview renders MCP tool calls via say/ask="use_mcp_server"
					// with ClineAskUseMcpServer JSON, not generic say="tool".
					const mcpInfo = parseMcpToolName(toolName)
					if (mcpInfo) {
						const mcpPayload = buildMcpToolPayload(mcpInfo, input)
						messages.push({
							ts: state.getStreamingToolTs(),
							type: "say",
							say: "use_mcp_server" as ClineSay,
							text: mcpPayload,
							partial: true,
						})
						break
					}

					// All other tools → say="tool" with ClineSayTool JSON
					// apply_patch is intentionally NOT split per-file here: the streaming
					// (partial) row shows the whole patch, and the per-file split happens
					// only at content_end (see below), mirroring read_files. Splitting at
					// content_start would mint streaming ids that content_end cannot
					// reproduce for files ≥2, orphaning those partial rows (cline#9904).
					const sayTool = toDisplaySayTool(sdkToolToClineSayTool(toolName, input), state.currentCwd())
					messages.push({
						ts: state.getStreamingToolTs(),
						type: "say",
						say: "tool",
						text: JSON.stringify(sayTool),
						partial: true,
					})
					break
				}
			}
			break
		}

		case "content_update": {
			const updateToolName = event.toolName ?? state.getStreamingToolName()
			if (updateToolName === "run_commands" || updateToolName === "execute_command") {
				const update = event.update
				if (
					state.getStreamingToolName() !== updateToolName ||
					!update ||
					typeof update !== "object" ||
					Array.isArray(update) ||
					!("chunk" in update) ||
					typeof update.chunk !== "string" ||
					!update.chunk
				) {
					break
				}
				const output = state.appendStreamingCommandOutput(event.toolCallId, update.chunk)
				if (output === undefined) {
					break
				}
				messages.push({
					ts: state.getStreamingToolTs(),
					type: "say",
					say: "command",
					text: `${extractCommandText(state.getStreamingToolInput())}\n${COMMAND_OUTPUT_STRING}\n${output}`,
					partial: true,
				})
				break
			}

			// spawn_agent progress updates → emit say:"subagent" with live stats.
			// The SDK's spawn_agent tool may emit content_update events with
			// sub-agent progress (iterations, tool calls, usage). We translate
			// these into the ClineSaySubagentStatus format for the rich UI.
			if (updateToolName === "spawn_agent" && state.hasSpawnAgents()) {
				const callId = event.toolCallId ?? ""
				const entry = callId ? state.getSpawnAgent(callId) : undefined
				if (entry) {
					// Apply progress from the update payload if available
					const updateData = event.update as Record<string, unknown> | undefined
					if (updateData) {
						if (typeof updateData.toolCalls === "number") entry.toolCalls = updateData.toolCalls
						if (typeof updateData.inputTokens === "number") entry.inputTokens = updateData.inputTokens
						if (typeof updateData.outputTokens === "number") entry.outputTokens = updateData.outputTokens
						if (typeof updateData.totalCost === "number") entry.totalCost = updateData.totalCost
						if (typeof updateData.contextTokens === "number") entry.contextTokens = updateData.contextTokens
						if (typeof updateData.contextWindow === "number") entry.contextWindow = updateData.contextWindow
						if (typeof updateData.contextUsagePercentage === "number")
							entry.contextUsagePercentage = updateData.contextUsagePercentage
						if (typeof updateData.latestToolCall === "string") entry.latestToolCall = updateData.latestToolCall
					}
				}
				// Emit a running status update
				const status = state.buildSubagentStatus("running")
				messages.push({
					ts: state.getSpawnAgentStatusTs(),
					type: "say",
					say: "subagent" as ClineSay,
					text: JSON.stringify(status),
					partial: true,
				})
				break
			}

			// For all other tools, content_update is ignored — the
			// content_start message with partial=true is sufficient until
			// content_end finalizes it.
			break
		}

		case "content_end": {
			switch (event.contentType) {
				case "text": {
					const ts = state.clearStreamingText()
					const finalText = event.text ?? ""
					messages.push({
						ts,
						type: "say",
						say: "text",
						text: finalText,
						partial: false,
					})
					// Candidate for the turn-final response: if the turn ends cleanly with
					// this text as its last content, `done` retags it as a completion row.
					if (finalText.trim()) {
						state.recordTurnFinalText(ts, finalText)
					}
					break
				}
				case "reasoning": {
					const ts = state.clearStreamingReasoning()
					const reasoning = event.reasoning ?? ""
					messages.push({
						ts,
						type: "say",
						say: "reasoning",
						text: reasoning,
						reasoning,
						partial: false,
					})
					break
				}
				case "media": {
					const media = event.media
					if (!media) {
						break
					}
					messages.push({
						ts: state.nextTs(),
						type: "say",
						say: "text",
						text: "",
						media: [media],
						partial: false,
					})
					break
				}
				case "tool": {
					const toolName = event.toolName ?? state.getStreamingToolName() ?? "unknown"
					if (state.isMismatchedStreamingCommand(toolName, event.toolCallId)) {
						break
					}

					// A completed tool call after a text block means that text wasn't the
					// turn-final response — drop the retag candidate.
					state.clearTurnFinalText()

					if (state.checkDeniedToolApproval(event.toolCallId) || isKnownToolApprovalDenial(event.error)) {
						state.clearStreamingTool()
						break
					}

					// ask_question is serviced by the interaction coordinator (see content_start);
					// it produces no transcript row of its own, so its content_end is a no-op.
					if (toolName === "ask_question" || toolName === "ask_followup_question") {
						break
					}

					// spawn_agent → finalize the subagent entry and emit
					// say:"subagent" (completed/failed) + say:"subagent_usage".
					// When all spawn_agent calls in this iteration finish, the
					// final say:"subagent" has partial=false.
					if (toolName === "spawn_agent") {
						const callId = event.toolCallId ?? ""
						const entry = callId ? state.getSpawnAgent(callId) : undefined
						if (entry) {
							// Extract output stats from SpawnAgentOutput
							const output = event.output as Record<string, unknown> | undefined
							if (output) {
								entry.result = typeof output.text === "string" ? output.text : undefined
								const usage = output.usage as Record<string, unknown> | undefined
								if (usage) {
									if (typeof usage.inputTokens === "number") entry.inputTokens = usage.inputTokens
									if (typeof usage.outputTokens === "number") entry.outputTokens = usage.outputTokens
								}
							}
							if (event.error) {
								entry.status = "failed"
								entry.error = event.error
							} else {
								entry.status = "completed"
							}
							Logger.log(
								`[Subagent] ${entry.status} · in ${entry.inputTokens ?? 0} / out ${entry.outputTokens ?? 0} tok` +
									(entry.error ? ` · ${entry.error}` : ""),
							)
						}

						// Determine overall status — all done when every entry is completed/failed
						const items = state.getSpawnAgentItems()
						const allDone = items.every((e) => e.status === "completed" || e.status === "failed")
						const hasFailed = items.some((e) => e.status === "failed")
						const overallStatus: ClineSaySubagentStatus["status"] = allDone
							? hasFailed
								? "failed"
								: "completed"
							: "running"

						const status = state.buildSubagentStatus(overallStatus)
						messages.push({
							ts: state.getSpawnAgentStatusTs(),
							type: "say",
							say: "subagent" as ClineSay,
							text: JSON.stringify(status),
							partial: !allDone,
						})

						// When all done, emit subagent_usage for cost accounting
						if (allDone) {
							const usagePayload: ClineSubagentUsageInfo = {
								source: "subagents",
								tokensIn: items.reduce((acc, e) => acc + (e.inputTokens || 0), 0),
								tokensOut: items.reduce((acc, e) => acc + (e.outputTokens || 0), 0),
								cacheWrites: 0,
								cacheReads: 0,
								cost: items.reduce((acc, e) => acc + (e.totalCost || 0), 0),
							}
							messages.push({
								ts: state.nextTs(),
								type: "say",
								say: "subagent_usage" as ClineSay,
								text: JSON.stringify(usagePayload),
								partial: false,
							})
						}

						// Don't clear the generic streaming tool — spawn_agent
						// didn't use it (we cleared it at content_start)
						break
					}

					// Completion tool (attempt_completion / submit_and_exit) → finalize the green
					// completion box. The partial say:"completion_result" was emitted at
					// content_start; here we emit the non-partial version.
					if (isCompletionTool(toolName)) {
						const storedInput = state.getStreamingToolInput()
						const ts = state.clearStreamingTool()
						const resultText = getCompletionResultText(storedInput)
						// Finalize the say:"completion_result" (non-partial)
						// This renders the green completion box.
						messages.push({
							ts,
							type: "say",
							say: "completion_result",
							text: resultText,
							partial: false,
						})
						// Only the say:"completion_result" is emitted (the green box). No
						// ask:"completion_result" is produced — the webview's footer/buttons read
						// the authoritative TurnState (phase "completed") rather than the message
						// tail, so the completion UI is immune to trailing bookkeeping events such as
						// the usage say:"api_req_started" that arrives between content_end and done.
						break
					}

					// command tools finalize as say="command" with commandCompleted=true.
					// We keep the same timestamp to replace the streaming partial command row
					// in-place, so it doesn't disappear (command_output rows are filtered out
					// by combineCommandSequences in the chat pipeline).
					if (toolName === "run_commands" || toolName === "execute_command") {
						const storedInput = state.getStreamingToolInput()
						const commandText = extractCommandText(storedInput)
						const outputStr = event.error ? `Error: ${event.error}` : extractToolOutputText(event.output)
						const ts = state.clearStreamingTool()
						messages.push({
							ts,
							type: "say",
							say: "command",
							text: outputStr ? `${commandText}\n${COMMAND_OUTPUT_STRING}\n${outputStr}` : commandText,
							partial: false,
							commandCompleted: true,
						})
						break
					}

					// ask_advisor → the advice (or why there is none) and its cost.
					if (isAdvisorTool(toolName)) {
						const storedInput = state.getStreamingToolInput()
						const questionTs = state.clearStreamingTool()
						messages.push(
							...advisorResultMessages({
								input: storedInput,
								output: event.output,
								error: event.error,
								questionTs,
								nextTs: () => state.nextTs(),
							}),
						)
						break
					}

					// MCP tools → finalize as say="use_mcp_server" + say="mcp_server_response"
					// The classic extension emits:
					//   1. say/ask: "use_mcp_server" (tool call display with args)
					//   2. say: "mcp_server_request_started" (spinner)
					//   3. say: "mcp_server_response" (tool output)
					// In the SDK path, by content_end the tool has already executed,
					// so we emit the finalized tool call + response together.
					const mcpInfoEnd = parseMcpToolName(toolName)
					if (mcpInfoEnd) {
						const storedMcpInput = state.getStreamingToolInput()
						const mcpTs = state.clearStreamingTool()
						const mcpPayload = buildMcpToolPayload(mcpInfoEnd, storedMcpInput)

						// Finalize the use_mcp_server message (non-partial)
						messages.push({
							ts: mcpTs,
							type: "say",
							say: "use_mcp_server" as ClineSay,
							text: mcpPayload,
							partial: false,
						})

						// Emit the MCP server response with the tool output
						const mcpOutputStr = event.error ? `Error: ${event.error}` : extractToolOutputText(event.output)
						if (mcpOutputStr) {
							messages.push({
								ts: state.nextTs(),
								type: "say",
								say: "mcp_server_response" as ClineSay,
								text: mcpOutputStr,
								partial: false,
							})
						}
						break
					}

					// All other tools → finalize the say="tool" message
					// Use the stored input from content_start since content_end
					// doesn't carry the input (S6-24 fix)
					const storedInput = state.getStreamingToolInput()
					const ts = state.clearStreamingTool()

					// Special handling: read_files may read multiple files in one tool call.
					// Emit one readFile UI message per file so the tool group summary and
					// list reflect what was actually read.
					if (toolName === "read_files" || toolName === "read_file") {
						const parsedInput = parseToolInput(storedInput)
						const fileReads = extractFileReads(parsedInput)
						if (fileReads.length > 1) {
							const cwd = state.currentCwd()
							fileReads.forEach((fileRead, index) => {
								const sayTool: ClineSayTool = {
									tool: "readFile",
									path: fileRead.path,
									...readLineRangeFields(fileRead),
								}
								messages.push({
									ts: index === 0 ? ts : state.nextTs(),
									type: "say",
									say: "tool",
									text: JSON.stringify(toDisplaySayTool(sayTool, cwd)),
									partial: false,
								})
							})
							break
						}
					}

					// apply_patch may edit multiple files in one call. Emit one tool
					// message per file so each diff row shows only that file's changes
					// instead of the whole multi-file patch (cline#9904). Single-file
					// patches fall through to the single-message path below.
					if (toolName === "apply_patch" && !event.error) {
						const patch = getApplyPatchString(storedInput)
						const perFileTools = patch ? splitApplyPatchByFile(patch) : []
						if (perFileTools.length > 1) {
							const cwd = state.currentCwd()
							perFileTools.forEach((sayTool, index) => {
								messages.push({
									ts: index === 0 ? ts : state.nextTs(),
									type: "say",
									say: "tool",
									text: JSON.stringify(toDisplaySayTool(sayTool, cwd)),
									partial: false,
								})
							})
							break
						}
					}

					const sayTool = toDisplaySayTool(sdkToolToClineSayTool(toolName, storedInput), state.currentCwd())
					// If there's an error, include it in the tool message
					if (event.error) {
						messages.push({
							ts,
							type: "say",
							say: "tool",
							text: JSON.stringify(sayTool),
							partial: false,
						})
						// Also push an error message
						messages.push({
							ts: state.nextTs(),
							type: "say",
							say: "error",
							text: event.error,
							partial: false,
						})
					} else {
						messages.push({
							ts,
							type: "say",
							say: "tool",
							text: JSON.stringify(sayTool),
							partial: false,
						})
					}
					break
				}
			}
			break
		}

		case "iteration_start": {
			// New iteration — reset streaming state for the new turn
			state.reset()

			// Emit an api_req_started message before each API request so the
			// webview shows its request spinner and cost display.
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					request: undefined, // Will be filled in by usage event
				} satisfies ClineApiReqInfo),
				partial: false,
			})
			break
		}

		case "iteration_end": {
			// Iteration ended — no specific message needed
			break
		}

		case "notice": {
			// Status notices carry structured runtime progress. Compaction ones
			// become a live divider row that is updated in place from "started" to
			// its terminal state; the known-internal ones are diagnostics with no
			// user-facing copy, so drop them explicitly. Any other status notice
			// falls through to the info row below so a future one surfaces (as its
			// raw slug) instead of silently vanishing.
			if (event.noticeType === "status") {
				const compaction = parseCompactionNoticeMetadata(event.metadata)
				if (compaction) {
					const ts =
						compaction.status === "started"
							? state.beginCompaction()
							: (state.takeOpenCompactionTs() ?? state.nextTs())
					messages.push(buildCompactionMessage(compaction, ts))
					break
				}
				if (INTERNAL_STATUS_NOTICES.has(event.message ?? "")) {
					break
				}
			}

			// Non-status agent notices (and unrecognized status notices) are informational
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "info",
				text: event.message ?? "",
				partial: false,
			})
			break
		}

		case "usage": {
			// Usage events carry token counts. The webview reads them from an
			// api_req_started message's ClineApiReqInfo, so emit a follow-up
			// api_req_started update carrying the usage data for cost display.
			const usageEvent = normalizeUsageEvent(event)
			const apiReqInfo: ClineApiReqInfo = {
				tokensIn: usageEvent.tokensIn,
				tokensOut: usageEvent.tokensOut,
				cacheWrites: usageEvent.cacheWrites,
				cacheReads: usageEvent.cacheReads,
				cost: usageEvent.totalCost,
				...(usageEvent.estimated ? { estimated: true } : {}),
				...(usageEvent.contextBreakdown ? { contextBreakdown: usageEvent.contextBreakdown } : {}),
			}
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify(apiReqInfo),
				partial: false,
			})
			break
		}

		case "done": {
			// Agent turn is complete. Footer/buttons come from the authoritative TurnState the
			// session-event coordinator sets on turn end (completed when the completion tool was
			// used this turn, otherwise awaiting_followup) — never from the message tail.
			// A compaction divider still open here means the turn was aborted mid-compaction.
			finalizeDanglingCompaction(state, messages, "cancelled")

			// A turn can terminate with done(reason:"error") without a separate
			// "error" event — record the error outcome here too so turn end still
			// resolves to the "error" phase (Retry / Start New Task).
			if (event.reason === "error") {
				state.setErrorSeen()
			}

			// Inferred completion feedback: the SDK agent normally ends a turn with a plain
			// text response rather than a completion tool. When the turn ended cleanly and its
			// last content was text, retag that text row in place (same ts → upserted by the
			// message store / webview reducer) so the user gets the legacy-style "done" visual:
			// green box in act mode, yellow plan box in plan mode. Turns
			// that ended via the completion tool already rendered their green box at the tool's
			// content_end; aborted/errored turns keep their plain text.
			if (event.reason === "completed" && !state.wasAttemptCompletionSeen()) {
				const finalText = state.takeTurnFinalText()
				if (finalText) {
					messages.push({
						ts: finalText.ts,
						type: "say",
						say: state.currentUiMode() === "plan" ? "plan_completion_result" : "completion_result",
						text: finalText.text,
						partial: false,
					})
				}
			} else {
				state.clearTurnFinalText()
			}
			break
		}

		case "error": {
			// Recoverable errors are in-run notices, not turn outcomes: the
			// MistakeTracker emits one for every recorded mistake (e.g.
			// "1 tool call(s) failed: [run_commands] ..." when a plan-mode
			// guard-blocked command was the turn's only tool call) and the run
			// keeps going. Treating them as terminal put turns that afterwards
			// completed cleanly into the "error" phase (Retry / Start New Task)
			// and cleared the pending completion retag — which broke the
			// plan→act toggle's auto-continue on a presented plan. The turn's
			// outcome is decided by how it actually ends (done/error), so keep
			// these out of the chat: any tool failure involved is already shown
			// inline on its tool row, and provider-failure telemetry already
			// ignores recoverable events for the same reason.
			if (event.recoverable) {
				Logger.warn(`[MessageTranslator] Recoverable agent error (run continues): ${event.error?.message ?? event.error}`)
				break
			}

			finalizeDanglingCompaction(state, messages, "failed")
			// An errored turn didn't end on its text response — no completion retag.
			state.clearTurnFinalText()
			if (state.isSuppressedToolApprovalDenial(event.error)) {
				break
			}

			// Record the error outcome so turn end resolves to the "error" phase
			// (footer shows Retry / Start New Task) instead of awaiting_followup.
			state.setErrorSeen()

			// Serialize the error message for the webview's ErrorRow to parse.
			// The webview uses ClineError.parse() on the `api_req_failed` text to
			// detect special error types (insufficient credits, spend limit, auth,
			// quota exceeded) and render appropriate UI (e.g. "Add Credits" button).
			//
			// The error object from the SDK is a standard JS Error. Its `message`
			// may contain JSON from the API (e.g. Cline provider's 402 response with
			// `code: "insufficient_credits"`). We try to reshape it into the
			// ClineError-serialized format the webview expects so that ErrorRow
			// can render the correct UI (Buy Credits button, etc.).
			const errorPayload = reshapeErrorForWebview(
				event.error,
				state.activeProviderId(),
				state.activeModelId(),
				event.errorClass,
			)

			// Emit an api_req_started with streamingFailedMessage so the
			// RequestStartRow renders the error via ErrorRow. This replaces
			// the spinner on the last API request row.
			messages.push({
				ts: state.nextTs(),
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					streamingFailedMessage: errorPayload,
				} satisfies ClineApiReqInfo),
				partial: false,
			})

			// Emit ask:"api_req_failed" as the LAST message so the webview
			// shows error recovery UI (Retry button, Add Credits button,
			// Sign In button, etc.) instead of a stuck "Thinking..." spinner.
			messages.push({
				ts: state.nextTs(),
				type: "ask",
				ask: "api_req_failed",
				text: errorPayload,
				partial: false,
			})
			break
		}

		default: {
			// Log unhandled event types for debugging
			Logger.warn(`[MessageTranslator] Unhandled agent event type: ${(event as AgentEvent).type}`)
			break
		}
	}

	return messages
}

// ---------------------------------------------------------------------------
// Core session event translation
// ---------------------------------------------------------------------------

/**
 * Translate an SDK CoreSessionEvent into a TranslationResult.
 *
 * This is the primary entry point for event translation. It handles
 * both top-level session events (chunk, ended, status) and nested
 * agent events.
 */
export function translateSessionEvent(event: CoreSessionEvent, state: MessageTranslatorState): TranslationResult {
	const result: TranslationResult = {
		messages: [],
		sessionEnded: false,
		turnComplete: false,
	}

	switch (event.type) {
		case "chunk": {
			// Raw chunk events from the session stream.
			// IMPORTANT: We do NOT emit these as text messages. The SDK sends
			// raw model output (which may contain JSON, tool call fragments, etc.)
			// as chunk events. The structured agent_event system (content_start,
			// content_update, content_end) is the proper way to get displayable
			// content. Emitting raw chunks would show JSON like
			// {"type":"iteration_start",...} in the webview.
			//
			// The chunk events are useful for logging but should not be
			// displayed to the user.
			break
		}

		case "agent_event": {
			// Sub-agent events should NOT produce ClineMessages in the main chat.
			// The sub-agent's work is represented by the parent's spawn_agent tool
			// events (content_start/update/end), which we translate into the rich
			// SubagentStatusRow UI. Without this filter, every sub-agent tool call,
			// text output, iteration, and usage event floods the main chat.
			const agentEvent = event.payload.event
			const isToolLifecycleEvent =
				agentEvent.type === "content_start" || agentEvent.type === "content_update" || agentEvent.type === "content_end"
			const isSpawnAgentToolEvent =
				isToolLifecycleEvent && agentEvent.contentType === "tool" && agentEvent.toolName === "spawn_agent"

			// Newer SDK events carry parentAgentId on sub-agent events. Older/local
			// RuntimeEventAdapter output does not, so while spawn_agent calls are in
			// flight we also suppress every non-spawn_agent event. This preserves the
			// parent spawn_agent status updates while hiding sub-agent internals.
			if (agentEvent.parentAgentId || (state.hasRunningSpawnAgents() && !isSpawnAgentToolEvent)) {
				break
			}

			// Agent events contain structured content (text, reasoning, tools)
			const agentMessages = translateAgentEvent(agentEvent, state)
			result.messages.push(...agentMessages)

			// Check for done/error events
			if (agentEvent.type === "done") {
				result.turnComplete = true
			}
			// Recoverable errors don't end the turn — the run continues (see the
			// translator's "error" case), so they must not resolve the turn phase.
			if (
				agentEvent.type === "error" &&
				!agentEvent.recoverable &&
				!state.isSuppressedToolApprovalDenial(agentEvent.error)
			) {
				result.turnComplete = true
			}

			// Track tool success/error for consecutive mistake counting.
			// A content_end event with contentType "tool" signals a completed
			// tool call — if event.error is set, the tool failed.
			if (agentEvent.type === "content_end" && agentEvent.contentType === "tool") {
				if (
					agentEvent.error &&
					!isKnownToolApprovalDenial(agentEvent.error) &&
					!state.isToolApprovalDenied(agentEvent.toolCallId)
				) {
					result.toolError = true
				} else if (!agentEvent.error) {
					result.toolSuccess = true
				}
			}

			// Extract usage from usage events
			if (agentEvent.type === "usage") {
				result.usage = normalizeUsageEvent(agentEvent)
			}
			break
		}

		case "ended": {
			result.sessionEnded = true
			result.turnComplete = true
			state.reset()
			break
		}

		case "hook": {
			// Sub-agent hook events are internal progress and should not pollute the
			// main chat. Their aggregate progress is shown by SubagentStatusRow.
			if (event.payload.parentAgentId) {
				break
			}

			// Tool hook events — translate to hook_status messages
			const payload = event.payload
			const hookName = payload.hookEventName
			const toolName = payload.toolName

			if (hookName === "tool_call") {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status" as ClineSay,
					text: toolName ? `Running ${toolName}...` : "Running tool...",
					partial: false,
				})
			} else if (hookName === "tool_result") {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "hook_status" as ClineSay,
					text: toolName ? `${toolName} completed` : "Tool completed",
					partial: false,
				})
			}
			break
		}

		case "status": {
			// Status updates — informational
			Logger.log(`[MessageTranslator] Session status: ${event.payload.status}`)
			break
		}

		case "pending_prompt_submitted": {
			const { prompt, userImages, userFiles } = event.payload
			// Synthetic prompts (task resumption, plan -> act auto-continue) are
			// hidden from every other transcript surface, and this echo must
			// hide them too: a send that races a settling abort is auto-queued
			// by the runtime, so a bare Resume can arrive here carrying the
			// synthetic resumption prompt. Echoing it would leak model-facing
			// text as a user bubble and shift the visible-user-message ordinals
			// that edit/regenerate mapping relies on. Attachments the user
			// supplied alongside a synthetic prompt still render (matching
			// isSyntheticSdkUserMessage, which counts those as visible).
			// Display boundary: formatDisplayUserInput strips runtime-generated
			// notice elements (e.g. mode_notice) that normalizeUserInput must
			// preserve, since the latter also sanitizes model-bound prompts.
			const displayPrompt = isSyntheticUserPrompt(prompt) ? "" : formatDisplayUserInput(prompt)
			const hasPrompt = displayPrompt.trim().length > 0
			const hasImages = (userImages?.length ?? 0) > 0
			const hasFiles = (userFiles?.length ?? 0) > 0
			if (hasPrompt || hasImages || hasFiles) {
				result.messages.push({
					ts: state.nextTs(),
					type: "say",
					say: "user_feedback",
					text: displayPrompt,
					images: userImages,
					files: userFiles,
					partial: false,
				})
			}
			break
		}

		case "team_progress":
		case "pending_prompts": {
			// These are handled by the team/subagent system, not translated
			// to ClineMessages at this layer
			break
		}

		default: {
			Logger.warn(`[MessageTranslator] Unhandled session event type: ${(event as CoreSessionEvent).type}`)
			break
		}
	}

	return result
}
