import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type { ClineAskUseMcpServer, ClineMessage, ClinePlanModeResponse, ClineSayTool } from "@shared/ExtensionMessage"
import { getApiMetrics } from "@shared/getApiMetrics"
import type { HistoryItem } from "@shared/HistoryItem"

/** Default number of output lines kept before a fenced block is truncated. */
export const DEFAULT_MAX_OUTPUT_LINES = 200

export interface ExportMarkdownOptions {
	/** Render tool/command output blocks. Off leaves just the one-line summary. */
	includeToolOutput?: boolean
	/** Render assistant reasoning inside a collapsed <details> block. */
	includeReasoning?: boolean
	/** Lines kept per fenced output block before the "... truncated" marker. */
	maxOutputLines?: number
	/** Extension version stamped into the metadata block. */
	plinyCodeVersion?: string
	/** Injectable for deterministic tests; defaults to a UTC timestamp. */
	formatDate?: (ts: number) => string
}

/**
 * say kinds that carry no conversation content: bookkeeping rows the chat view
 * renders as dividers, spinners or status chips. They are skipped here, but
 * `api_req_started` / `deleted_api_reqs` / `subagent_usage` are still read by
 * getApiMetrics for the metadata block.
 */
const INTERNAL_SAYS: ReadonlySet<string> = new Set([
	"api_req_started",
	"api_req_finished",
	"deleted_api_reqs",
	"checkpoint_created",
	"compaction",
	"subagent",
	"use_subagents",
	"subagent_usage",
	"task_progress",
	"hook_status",
	"hook_output_stream",
	"conditional_rules_applied",
	"mcp_server_request_started",
	"load_mcp_documentation",
	"shell_integration_warning",
	"shell_integration_warning_with_suggestion",
])

/**
 * ask kinds that only exist to drive approval buttons. The tool or command they
 * describe is re-emitted as a `say` row once it runs, so exporting the ask too
 * would duplicate every action.
 */
const INTERNAL_ASKS: ReadonlySet<string> = new Set([
	"tool",
	"command",
	"command_output",
	"use_mcp_server",
	"use_subagents",
	"browser_action_launch",
	"resume_task",
	"resume_completed_task",
	"new_task",
	"condense",
	"summarize_task",
	"report_bug",
	"api_req_failed",
	"mistake_limit_reached",
	"completion_result",
])

/** Rows that start a new "## User" section. Everything else is PlinyCode's. */
function isUserMessage(message: ClineMessage): boolean {
	if (message.type !== "say") {
		return false
	}
	return message.say === "task" || message.say === "user_feedback" || message.say === "user_feedback_diff"
}

/** Fence long enough to survive backticks inside the payload. */
function fence(language: string, body: string): string {
	const longestRun = [...body.matchAll(/`+/g)].reduce((max, match) => Math.max(max, match[0].length), 0)
	const ticks = "`".repeat(Math.max(3, longestRun + 1))
	return `${ticks}${language}\n${body}\n${ticks}`
}

function truncateLines(text: string, maxLines: number): string {
	const lines = text.split("\n")
	if (maxLines <= 0 || lines.length <= maxLines) {
		return text
	}
	const omitted = lines.length - maxLines
	return `${lines.slice(0, maxLines).join("\n")}\n... truncated (${omitted} more ${omitted === 1 ? "line" : "lines"})`
}

function parseJson<T>(text: string | undefined): T | undefined {
	if (!text) {
		return undefined
	}
	try {
		return JSON.parse(text) as T
	} catch {
		return undefined
	}
}

/** Inline code span. Backticks in the value would break out of the span. */
function code(value: string): string {
	return `\`${value.replace(/`/g, "’")}\``
}

/** "Edited `path`" / "Read `path`" / … — the one-line summary of a tool row. */
function toolSummary(tool: ClineSayTool): string {
	const target = tool.path ? code(tool.path) : ""
	switch (tool.tool) {
		case "editedExistingFile":
			return `Edited ${target}`
		case "newFileCreated":
			return `Created ${target}`
		case "fileDeleted":
			return `Deleted ${target}`
		case "readFile": {
			const range =
				tool.readLineStart === undefined
					? ""
					: ` (lines ${tool.readLineStart}${tool.readLineEnd === undefined ? "+" : `-${tool.readLineEnd}`})`
			return `Read ${target}${range}`
		}
		case "listFilesTopLevel":
			return `Listed files in ${target}`
		case "listFilesRecursive":
			return `Listed files recursively in ${target}`
		case "listCodeDefinitionNames":
			return `Listed code definitions in ${target}`
		case "searchFiles": {
			const where = tool.path ? ` in ${code(tool.path)}` : ""
			const filter = tool.filePattern ? ` matching ${code(tool.filePattern)}` : ""
			return `Searched for ${code(tool.regex ?? "")}${where}${filter}`
		}
		case "webFetch":
			return `Fetched ${target}`
		case "webSearch":
			return `Searched the web for ${target}`
		case "useSkill":
			return `Used skill ${target}`
		case "summarizeTask":
			return "Summarized the task"
		default:
			return `Used ${code(String(tool.tool))}${tool.path ? ` on ${code(tool.path)}` : ""}`
	}
}

const FENCE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
	c: "c",
	cc: "cpp",
	cpp: "cpp",
	cs: "csharp",
	css: "css",
	go: "go",
	h: "c",
	hpp: "cpp",
	html: "html",
	java: "java",
	js: "javascript",
	json: "json",
	jsx: "jsx",
	kt: "kotlin",
	md: "markdown",
	mjs: "javascript",
	php: "php",
	proto: "proto",
	py: "python",
	rb: "ruby",
	rs: "rust",
	sh: "bash",
	sql: "sql",
	swift: "swift",
	toml: "toml",
	ts: "typescript",
	tsx: "tsx",
	xml: "xml",
	yaml: "yaml",
	yml: "yaml",
}

/** Infer a fence language from a file extension so sources highlight. */
function languageForPath(filePath: string | undefined): string {
	const extension = filePath?.match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase()
	return (extension && FENCE_LANGUAGE_BY_EXTENSION[extension]) || ""
}

function formatNumber(value: number | undefined): string {
	return (value ?? 0).toLocaleString("en-US")
}

/**
 * A stored image is either a path or a `data:` URI. Paths keep their basename;
 * data URIs become a placeholder naming the media type, so the exported file
 * never carries megabytes of base64.
 */
function imageReference(image: string): string {
	if (image.startsWith("data:")) {
		const separator = image.indexOf(";")
		const mediaType = separator === -1 ? "" : image.slice("data:".length, separator)
		return mediaType ? `embedded ${mediaType} image` : "embedded image"
	}
	const normalized = image.replace(/\\/g, "/")
	return normalized.slice(normalized.lastIndexOf("/") + 1) || image
}

/** Images and files are referenced by name only — never inlined as base64. */
function attachmentLines(message: ClineMessage): string[] {
	const lines: string[] = []
	const imageNames = (message.images ?? []).map(imageReference).filter((name) => name.length > 0)
	if (imageNames.length > 0) {
		lines.push(`_Images: ${imageNames.map(code).join(", ")}_`)
	}
	const fileNames = (message.files ?? []).filter((file) => file.length > 0)
	if (fileNames.length > 0) {
		lines.push(`_Files: ${fileNames.map(code).join(", ")}_`)
	}
	return lines
}

function escapeTableCell(value: string): string {
	return value.replace(/\|/g, "\\|")
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n")[0]?.trim() ?? ""
}

function defaultFormatDate(ts: number): string {
	return `${new Date(ts).toISOString().replace("T", " ").slice(0, 16)} UTC`
}

interface RenderMessageOptions {
	includeToolOutput: boolean
	includeReasoning: boolean
	maxOutputLines: number
}

/**
 * Render one stored conversation as a standalone Markdown document.
 *
 * Pure: no filesystem, no host bridge, no clock beyond the timestamps already
 * on the inputs. The caller decides where the string is written.
 */
export function renderConversationMarkdown(
	historyItem: HistoryItem,
	messages: ClineMessage[],
	options: ExportMarkdownOptions = {},
): string {
	const {
		includeToolOutput = true,
		includeReasoning = false,
		maxOutputLines = DEFAULT_MAX_OUTPUT_LINES,
		plinyCodeVersion,
		formatDate = defaultFormatDate,
	} = options

	const metrics = getApiMetrics(messages)
	const out: string[] = []

	out.push(`# ${firstLine(historyItem.task) || "PlinyCode Conversation"}`, "")

	const metadata: [string, string][] = [["Date", formatDate(historyItem.ts)]]
	if (historyItem.cwdOnTaskInitialization) {
		metadata.push(["Workspace", historyItem.cwdOnTaskInitialization])
	}
	if (historyItem.modelId) {
		metadata.push(["Model", historyItem.modelId])
	}
	if (historyItem.apiProvider) {
		metadata.push(["Provider", historyItem.apiProvider])
	}
	metadata.push(["Tokens in", formatNumber(metrics.totalTokensIn)], ["Tokens out", formatNumber(metrics.totalTokensOut)])
	if (metrics.totalCacheWrites) {
		metadata.push(["Cache writes", formatNumber(metrics.totalCacheWrites)])
	}
	if (metrics.totalCacheReads) {
		metadata.push(["Cache reads", formatNumber(metrics.totalCacheReads)])
	}
	metadata.push(
		["Cost", `$${metrics.totalCost.toFixed(4)}`],
		["Exported by", plinyCodeVersion ? `PlinyCode ${plinyCodeVersion}` : "PlinyCode"],
	)

	out.push("| | |", "| --- | --- |")
	for (const [label, value] of metadata) {
		out.push(`| **${label}** | ${escapeTableCell(value)} |`)
	}
	out.push("")

	let currentSection: "user" | "assistant" | undefined
	for (const message of messages) {
		// Partial rows are mid-stream duplicates of a final row with the same ts.
		if (message.partial) {
			continue
		}
		const blocks = renderMessage(message, { includeToolOutput, includeReasoning, maxOutputLines })
		if (blocks.length === 0) {
			continue
		}
		const section = isUserMessage(message) ? "user" : "assistant"
		if (currentSection !== section) {
			out.push(section === "user" ? "## User" : "## PlinyCode", "")
			currentSection = section
		}
		for (const block of blocks) {
			out.push(block, "")
		}
	}

	// Collapse the runs of blank lines introduced by the per-block spacing above.
	return `${out
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trimEnd()}\n`
}

/** Markdown blocks for one message; empty when the row carries no content. */
function renderMessage(message: ClineMessage, options: RenderMessageOptions): string[] {
	return message.type === "ask" ? renderAsk(message) : renderSay(message, options)
}

function renderAsk(message: ClineMessage): string[] {
	if (!message.ask || INTERNAL_ASKS.has(message.ask)) {
		return []
	}
	if (message.ask === "followup") {
		const question = parseJson<{ question?: string }>(message.text)?.question ?? message.text
		return question ? [question.trim()] : []
	}
	if (message.ask === "plan_mode_respond" || message.ask === "act_mode_respond") {
		const response = parseJson<ClinePlanModeResponse>(message.text)?.response ?? message.text
		return response ? [response.trim()] : []
	}
	return message.text ? [message.text.trim()] : []
}

function renderSay(message: ClineMessage, options: RenderMessageOptions): string[] {
	const { say } = message
	if (!say || INTERNAL_SAYS.has(say)) {
		return []
	}

	switch (say) {
		case "task":
		case "user_feedback":
		case "text":
		case "completion_result":
		case "plan_completion_result":
		case "info": {
			const body = (message.text ?? "").trim()
			return [...(body ? [body] : []), ...attachmentLines(message)]
		}

		case "user_feedback_diff": {
			const diff = parseJson<ClineSayTool>(message.text)?.diff ?? message.text
			return diff ? [fence("diff", diff.trimEnd())] : []
		}

		case "reasoning": {
			if (!options.includeReasoning) {
				return []
			}
			const body = (message.reasoning ?? message.text ?? "").trim()
			return body ? [`<details>\n<summary>Reasoning</summary>\n\n${body}\n\n</details>`] : []
		}

		case "error":
		case "diff_error":
		case "clineignore_error":
		case "command_permission_denied": {
			const body = (message.text ?? "").trim()
			return body ? [`> **Error:** ${body.split("\n").join("\n> ")}`] : []
		}

		case "command":
			return renderCommand(message, options)

		case "command_output": {
			// Normally folded into the command row; a stray one still gets its output.
			const body = (message.text ?? "").trim()
			return body && options.includeToolOutput ? [fence("shell", truncateLines(body, options.maxOutputLines))] : []
		}

		case "tool":
			return renderTool(message, options)

		case "use_mcp_server": {
			const payload = parseJson<ClineAskUseMcpServer>(message.text)
			if (!payload) {
				return message.text ? [message.text.trim()] : []
			}
			const blocks = [
				payload.type === "access_mcp_resource"
					? `Accessed MCP resource ${code(payload.uri ?? "")} on ${code(payload.serverName)}`
					: `Called MCP tool ${code(payload.toolName ?? "")} on ${code(payload.serverName)}`,
			]
			if (options.includeToolOutput && payload.arguments) {
				blocks.push(fence("json", truncateLines(payload.arguments.trim(), options.maxOutputLines)))
			}
			return blocks
		}

		case "mcp_server_response": {
			const body = (message.text ?? "").trim()
			return body && options.includeToolOutput ? [fence("", truncateLines(body, options.maxOutputLines))] : []
		}

		case "browser_action":
		case "browser_action_launch":
		case "browser_action_result":
		case "mcp_notification": {
			const body = (message.text ?? "").trim()
			return body ? [body] : []
		}

		default:
			return []
	}
}

function renderCommand(message: ClineMessage, options: RenderMessageOptions): string[] {
	const text = message.text ?? ""
	const separatorIndex = text.indexOf(COMMAND_OUTPUT_STRING)
	const command = (separatorIndex === -1 ? text : text.slice(0, separatorIndex)).trim()
	const output = separatorIndex === -1 ? "" : text.slice(separatorIndex + COMMAND_OUTPUT_STRING.length).trim()

	const blocks: string[] = []
	if (command) {
		// A one-liner reads better as just the summary; the fence would repeat it
		// verbatim. Multi-line commands keep the fence so they stay readable.
		blocks.push(`Ran ${code(firstLine(command))}`)
		if (command.includes("\n")) {
			blocks.push(fence("shell", command))
		}
	}
	if (output && options.includeToolOutput) {
		blocks.push(fence("shell", truncateLines(output, options.maxOutputLines)))
	}
	return blocks
}

function renderTool(message: ClineMessage, options: RenderMessageOptions): string[] {
	const tool = parseJson<ClineSayTool>(message.text)
	if (!tool) {
		return message.text ? [message.text.trim()] : []
	}

	const blocks = [toolSummary(tool)]
	if (!options.includeToolOutput) {
		return blocks
	}

	const body = (tool.diff ?? tool.content ?? "").trimEnd()
	if (body) {
		const isEdit = tool.tool === "editedExistingFile" || tool.tool === "newFileCreated"
		// A search/replace or unified patch renders as a diff; whole-file content
		// keeps the language of the file it came from.
		const language = isEdit && (tool.diff || body.includes("------- SEARCH")) ? "diff" : languageForPath(tool.path)
		blocks.push(fence(language, truncateLines(body, options.maxOutputLines)))
	}
	return blocks
}
