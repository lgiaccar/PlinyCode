// SDK tool name → classic ClineSayTool mapping, display-path relativization,
// and MCP tool detection. Split out of message-translator.ts (see
// message-translator/index.ts).

import { PATCH_MARKERS } from "@plinycode/core"
import type { ClineAskUseMcpServer, ClineSayTool } from "@shared/ExtensionMessage"
import * as path from "path"
import { arePathsEqual, getDesktopDir } from "@/utils/path"
import {
	extractFileReads,
	formatStructuredCommand,
	getApplyPatchString,
	getArrayField,
	getBooleanField,
	getCommandArrayField,
	getNumberField,
	getStringField,
	parseToolInput,
	readLineRangeFields,
} from "./tool-input-parse"

// ---------------------------------------------------------------------------
// Display-path relativization
// ---------------------------------------------------------------------------

/**
 * Tools whose ClineSayTool.path is a filesystem path. webFetch/webSearch/
 * useSkill and MCP tools reuse `path` for URLs, queries, and names, so they
 * are deliberately excluded.
 */
const FILESYSTEM_PATH_TOOLS: ReadonlySet<ClineSayTool["tool"]> = new Set([
	"readFile",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"editedExistingFile",
	"newFileCreated",
	"fileDeleted",
	"searchFiles",
])

/**
 * Relativize a ClineSayTool's filesystem paths against the task cwd before it
 * is shown in the chat view, restoring the classic extension's getReadablePath
 * display behavior that was lost in the SDK migration (the SDK works with
 * absolute paths). Display-only — executors receive the raw tool input.
 */
export function toDisplaySayTool(sayTool: ClineSayTool, cwd: string | undefined): ClineSayTool {
	if (!cwd || !FILESYSTEM_PATH_TOOLS.has(sayTool.tool)) {
		return sayTool
	}
	if (sayTool.tool === "readFile") {
		// The webview's readFile card opens `content` in the editor on click, so it
		// carries the absolute path (classic-extension behavior). Already-absolute
		// paths pass through untouched — path.resolve would rewrite a drive-less
		// absolute path onto the current drive on Windows.
		const openTarget = sayTool.path
			? path.isAbsolute(sayTool.path)
				? sayTool.path
				: path.resolve(cwd, sayTool.path)
			: sayTool.content
		return {
			...sayTool,
			path: toDisplayPath(sayTool.path, cwd),
			content: openTarget,
		}
	}
	return {
		...sayTool,
		path: toDisplayPath(sayTool.path, cwd),
		// apply_patch payloads carry "*** Update File: <path>" markers that
		// DiffEditRow renders as the diff headers, so relativize those too.
		content: relativizePatchPaths(sayTool.content, cwd),
		diff: relativizePatchPaths(sayTool.diff, cwd),
	}
}

/**
 * Mirror the classic getReadablePath: paths inside the cwd render relative,
 * the cwd itself renders as its basename, and anything outside the cwd stays
 * absolute so the user still sees exactly where the operation happened.
 */
function toDisplayPath(rawPath: string | undefined, cwd: string): string | undefined {
	if (!rawPath || !path.isAbsolute(rawPath)) {
		return rawPath
	}
	// User opened VS Code without a workspace, so the cwd fell back to the
	// Desktop. Keep full absolute paths so the user stays aware of where
	// operations occur (classic getReadablePath behavior).
	if (arePathsEqual(cwd, getDesktopDir())) {
		return rawPath.replace(/\\/g, "/")
	}
	const relative = path.relative(cwd, rawPath)
	if (relative === "") {
		return path.basename(rawPath).replace(/\\/g, "/")
	}
	// Outside the cwd (or on another drive on Windows) — keep the absolute path.
	// Match ".." only as a whole segment so an in-cwd entry literally named
	// "..config" is not misclassified as outside.
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		return rawPath.replace(/\\/g, "/")
	}
	return relative.replace(/\\/g, "/")
}

/** Rewrite the "*** Add/Update/Delete File:" and "*** Move to:" markers inside a patch payload. */
function relativizePatchPaths(patch: string | undefined, cwd: string): string | undefined {
	if (!patch) {
		return patch
	}
	const fileMarkers = [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE, PATCH_MARKERS.MOVE]
	return patch
		.split("\n")
		.map((line) => {
			const marker = fileMarkers.find((m) => line.startsWith(m))
			return marker ? marker + (toDisplayPath(line.substring(marker.length).trim(), cwd) ?? "") : line
		})
		.join("\n")
}

// ---------------------------------------------------------------------------
// SDK tool name → classic ClineSayTool mapping
// ---------------------------------------------------------------------------

/**
 * Map an SDK tool name and its input to a ClineSayTool object that the
 * webview's ChatRow.tsx can render.
 *
 * The webview does `JSON.parse(message.text) as ClineSayTool` when
 * `say === "tool"`, so the text MUST be valid ClineSayTool JSON.
 *
 * SDK tool names → classic tool names:
 *   read_files/read_file               → readFile
 *   list_files                         → listFilesTopLevel / listFilesRecursive
 *   list_code_definition_names         → listCodeDefinitionNames
 *   editor/replace_in_file             → editedExistingFile
 *   write_to_file                      → newFileCreated
 *   apply_patch                        → editedExistingFile
 *   delete_file                        → fileDeleted
 *   run_commands/execute_command       → (uses say="command", NOT say="tool")
 *   search_codebase/search_files       → searchFiles
 *   find_files                         → listFilesRecursive
 *   fetch_web_content/web_fetch        → webFetch
 *   web_search                         → webSearch
 *   skills/use_skill                   → useSkill
 *   save_memory                        → saveMemory (path: "repo" | "user", content: the memory)
 *   search_conversations               → searchConversations (path: the query)
 *   read_conversation                  → readConversation (path: the conversation id)
 *   ask_question/ask_followup_question → (not a visual tool — handled by askQuestion executor in SdkController)
 *   MCP tools (serverName__toolName)   → (handled before reaching sdkToolToClineSayTool — emitted as say="use_mcp_server")
 */
export function sdkToolToClineSayTool(toolName: string, input?: unknown): ClineSayTool {
	// Parse input if it's a string (some SDK tools pass stringified JSON)
	const parsedInput = parseToolInput(input)

	switch (toolName) {
		case "read_files":
		case "read_file": {
			const fileRead = extractFileReads(parsedInput)[0]
			return {
				tool: "readFile",
				path: fileRead?.path ?? "",
				...readLineRangeFields(fileRead),
			}
		}

		case "list_files": {
			const dirPath = getStringField(parsedInput, "path") ?? ""
			const recursive = getBooleanField(parsedInput, "recursive") ?? false
			return {
				tool: recursive ? "listFilesRecursive" : "listFilesTopLevel",
				path: dirPath,
			}
		}

		case "list_code_definition_names": {
			const dirPath = getStringField(parsedInput, "path") ?? ""
			return {
				tool: "listCodeDefinitionNames",
				path: dirPath,
			}
		}

		case "editor":
		case "replace_in_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const newText =
				getStringField(parsedInput, "new_text") ??
				getStringField(parsedInput, "new_str") ??
				getStringField(parsedInput, "content")
			const patch = getStringField(parsedInput, "patch") ?? getStringField(parsedInput, "diff")
			const oldText = getStringField(parsedInput, "old_text") ?? getStringField(parsedInput, "old_str")
			// `insert_line` inserts into an existing file (the SDK editor executor requires
			// the file to already exist), so it is an edit — not a new-file creation. Without
			// this the card mislabels a prepend/insert as "Cline wants to create a new file".
			const insertLine = getNumberField(parsedInput, "insert_line")
			const isEdit = toolName === "replace_in_file" || !!oldText || insertLine != null

			// When the SDK provides both old and new text, build a search/replace
			// diff in the format DiffEditRow expects. ChatRow passes `content` to
			// DiffEditRow's `patch` prop, so the formatted diff must go into `content`.
			const diffContent = oldText && newText ? `------- SEARCH\n${oldText}\n=======\n${newText}\n+++++++ REPLACE` : newText

			return {
				tool: isEdit ? "editedExistingFile" : "newFileCreated",
				path: filePath,
				content: diffContent,
				diff: patch,
			}
		}

		case "write_to_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const content = getStringField(parsedInput, "content") ?? getStringField(parsedInput, "new_text")
			return {
				tool: "newFileCreated",
				path: filePath,
				content,
			}
		}

		case "apply_patch": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			const patch = getApplyPatchString(input)
			return {
				tool: "editedExistingFile",
				path: filePath,
				content: patch,
				diff: patch,
			}
		}

		case "delete_file": {
			const filePath = getStringField(parsedInput, "path") ?? ""
			return {
				tool: "fileDeleted",
				path: filePath,
			}
		}

		case "search_codebase":
		case "search_files": {
			// The SDK's SearchCodebaseUnionInputSchema accepts multiple formats:
			//   1. { queries: string[] }  — standard object (parsedInput handles this)
			//   2. { queries: string }    — queries as single string
			//   3. string[]               — bare array (parseToolInput returns undefined for arrays)
			//   4. string                 — bare string (parseToolInput tries JSON.parse, returns undefined if not an object)
			// We must handle all four to avoid showing empty regex in the UI.
			let regex = ""
			if (parsedInput) {
				// Cases 1 & 2: input was an object with a "queries" field
				const queries = getArrayField(parsedInput, "queries")
				regex =
					queries?.join(", ") ?? getStringField(parsedInput, "queries") ?? getStringField(parsedInput, "regex") ?? ""
			} else if (Array.isArray(input)) {
				// Case 3: bare array of query strings
				regex = input.map(String).join(", ")
			} else if (typeof input === "string") {
				// Case 4: bare string query
				regex = input
			}
			const path = getStringField(parsedInput, "path")
			const filePattern =
				getStringField(parsedInput, "glob") ??
				getStringField(parsedInput, "file_pattern") ??
				getStringField(parsedInput, "filePattern")
			return {
				tool: "searchFiles",
				regex,
				path,
				filePattern,
			}
		}

		case "find_files": {
			// Shown as a recursive listing of what was looked for: the patterns, under
			// the directory when one was given. Bare-string and bare-array inputs are
			// accepted, as for search_codebase.
			const patterns = parsedInput
				? (getArrayField(parsedInput, "patterns")?.join(", ") ??
					getStringField(parsedInput, "patterns") ??
					getStringField(parsedInput, "pattern") ??
					"")
				: Array.isArray(input)
					? input.map(String).join(", ")
					: typeof input === "string"
						? input
						: ""
			const dirPath = getStringField(parsedInput, "path")
			return {
				tool: "listFilesRecursive",
				path: dirPath ? `${dirPath.replace(/[/]+$/, "")}/${patterns}` : patterns,
			}
		}

		case "fetch_web_content":
		case "web_fetch": {
			// fetch_web_content carries { requests: [{ url, prompt }] };
			// web_fetch carries { url, prompt } directly.
			let url = getStringField(parsedInput, "url") ?? ""
			if (!url && parsedInput) {
				const requests = parsedInput.requests
				if (Array.isArray(requests) && requests.length > 0) {
					const firstRequest = requests[0]
					if (typeof firstRequest === "object" && firstRequest !== null) {
						url = ((firstRequest as Record<string, unknown>).url as string) ?? ""
					}
				}
			}
			return {
				tool: "webFetch",
				path: url,
			}
		}

		case "web_search": {
			const query = getStringField(parsedInput, "query") ?? getStringField(parsedInput, "q") ?? ""
			return {
				tool: "webSearch",
				path: query,
			}
		}

		case "skills":
		case "use_skill": {
			// skills carries { skill: "name", args?: "..." };
			// use_skill carries { skill_name: "name" }.
			const skillName =
				getStringField(parsedInput, "skill_name") ??
				getStringField(parsedInput, "skill") ??
				getStringField(parsedInput, "name") ??
				""
			return {
				tool: "useSkill",
				path: skillName,
			}
		}

		case "save_memory": {
			const scope = getStringField(parsedInput, "scope")?.toLowerCase()
			return {
				tool: "saveMemory",
				path: scope === "user" || scope === "global" || scope === "personal" ? "user" : "repo",
				content: getStringField(parsedInput, "text") ?? getStringField(parsedInput, "memory") ?? "",
			}
		}

		case "search_conversations":
			return { tool: "searchConversations", path: getStringField(parsedInput, "query") ?? "" }

		case "read_conversation":
			return { tool: "readConversation", path: getStringField(parsedInput, "session_id") ?? "" }

		default: {
			// MCP tools and unknown tools — pass through with the raw tool name.
			const filePath =
				getStringField(parsedInput, "path") ??
				getStringField(parsedInput, "url") ??
				getStringField(parsedInput, "command") ??
				""
			return {
				tool: toolName as ClineSayTool["tool"],
				path: filePath,
			}
		}
	}
}

/**
 * Whether a tool name is the agent's completion tool — the one that declares the task done and
 * drives the green completion box plus the `completed` turn phase. Two names are accepted:
 * the legacy VSCode extra tool `attempt_completion` (no longer registered for new sessions,
 * but still present in persisted transcripts) and the SDK's built-in `submit_and_exit`
 * (DefaultToolNames.SUBMIT_AND_EXIT, lifecycle.completesRun=true).
 */
export function isCompletionTool(toolName: string): boolean {
	return toolName === "submit_and_exit" || toolName === "attempt_completion"
}

/**
 * Extract the completion summary text from a completion-tool input. `attempt_completion` carries
 * it in `result`; `submit_and_exit` carries it in `summary`. Either renders the same completion UI.
 */
export function getCompletionResultText(input: unknown): string {
	const parsed = parseToolInput(input)
	return getStringField(parsed, "summary") ?? getStringField(parsed, "result") ?? ""
}

/**
 * Extract raw text output from an SDK tool's output.
 *
 * The SDK's run_commands tool returns `ToolOperationResult[]` where each
 * result has `{ query, result, success, error? }`. The `result` field
 * contains the raw terminal output as a string. If the output is already
 * a string, it is returned as-is. If it's an array of ToolOperationResult
 * objects, extract and join the text from each result.
 */
export function extractToolOutputText(output: unknown): string {
	if (output == null) return ""
	if (typeof output === "string") return output

	// Handle ToolOperationResult[] from SDK tools (run_commands, search_codebase, etc.)
	if (Array.isArray(output)) {
		const parts: string[] = []
		for (const item of output) {
			if (typeof item === "string") {
				parts.push(item)
			} else if (typeof item === "object" && item !== null) {
				const record = item as Record<string, unknown>
				// ToolOperationResult has { query, result, success, error? }
				if ("result" in record && typeof record.result === "string" && record.result) {
					parts.push(record.result)
				} else if ("error" in record && typeof record.error === "string" && record.error) {
					parts.push(record.error)
				}
			}
		}
		if (parts.length > 0) {
			return parts.join("\n")
		}
	}

	// Fallback for unknown structured output
	return JSON.stringify(output)
}

// ---------------------------------------------------------------------------
// MCP tool detection
// ---------------------------------------------------------------------------

/**
 * MCP tools created by `createMcpTools()` use `serverName__toolName` format
 * (double underscore separator). This function detects MCP tools and parses
 * the server name and tool name.
 *
 * Returns undefined if the tool name doesn't match the MCP naming convention.
 */
export function parseMcpToolName(toolName: string): { serverName: string; toolName: string } | undefined {
	const separatorIndex = toolName.indexOf("__")
	if (separatorIndex <= 0) return undefined
	const serverName = toolName.substring(0, separatorIndex)
	const mcpToolName = toolName.substring(separatorIndex + 2)
	if (!mcpToolName) return undefined
	return { serverName, toolName: mcpToolName }
}

/**
 * Build a ClineAskUseMcpServer JSON payload for MCP tool calls.
 * This is what the webview's ChatRow expects when rendering MCP tool calls
 * (message.ask === "use_mcp_server" or message.say === "use_mcp_server").
 */
export function buildMcpToolPayload(mcpInfo: { serverName: string; toolName: string }, input?: unknown): string {
	const parsedInput = parseToolInput(input)
	// Format arguments as a JSON string (matching classic ClineAskUseMcpServer.arguments)
	let argumentsStr: string | undefined
	if (parsedInput && Object.keys(parsedInput).length > 0) {
		argumentsStr = JSON.stringify(parsedInput, null, 2)
	} else if (typeof input === "string" && input.trim()) {
		argumentsStr = input
	}

	return JSON.stringify({
		type: "use_mcp_tool",
		serverName: mcpInfo.serverName,
		toolName: mcpInfo.toolName,
		arguments: argumentsStr,
	} satisfies ClineAskUseMcpServer)
}

export function extractCommandText(input: unknown): string {
	if (Array.isArray(input)) {
		return input.map(formatStructuredCommand).join(" && ")
	}
	if (typeof input === "string") {
		return input
	}
	const parsedInput = parseToolInput(input)
	const commands = getCommandArrayField(parsedInput, "commands")
	return (
		commands?.join(" && ") ??
		(typeof parsedInput?.commands === "object" ? formatStructuredCommand(parsedInput.commands) : undefined) ??
		getStringField(parsedInput, "commands") ??
		(typeof parsedInput?.command === "string" ? formatStructuredCommand(parsedInput) : undefined) ??
		""
	)
}
