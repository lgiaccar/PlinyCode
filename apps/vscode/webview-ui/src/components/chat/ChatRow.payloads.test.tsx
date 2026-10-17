import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: false,
		mcpServers: [],
		vscodeTerminalExecutionMode: "vscodeTerminal",
		clineMessages: [],
		showFeatureTips: false,
		enableCheckpointsSetting: false,
	}),
}))

// Every client method resolves; the rows only call them on clicks.
vi.mock("@/services/grpc-client", () => {
	const client = new Proxy({}, { get: () => vi.fn(() => Promise.resolve({})) })
	return new Proxy({}, { get: (_target, name) => (name === "then" ? undefined : client) })
})

vi.mock("@/components/common/CodeAccordian", () => ({
	default: ({ path, code, diff }: { path?: string; code?: string; diff?: string }) => (
		<div data-testid="code-accordian">{path ?? code ?? diff}</div>
	),
	cleanPathPrefix: (path: string) => path,
}))

vi.mock("./MarkdownRow", () => ({
	MarkdownRow: ({ markdown }: { markdown?: string }) => <div>{markdown}</div>,
}))

vi.mock("../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown?: string }) => <div>{markdown}</div>,
}))

import ChatRow from "./ChatRow"

function sayMessage(say: ClineMessage["say"], text: string, ts = 1_000): ClineMessage {
	return { ts, type: "say", say, text, partial: false }
}

function askMessage(ask: ClineMessage["ask"], text: string, ts = 1_000): ClineMessage {
	return { ts, type: "ask", ask, text, partial: false }
}

function renderRow(message: ClineMessage) {
	return render(
		<ChatRow
			isExpanded={false}
			isLast={false}
			message={message}
			onHeightChange={vi.fn()}
			onLastRowContentChange={vi.fn()}
			onSetQuote={vi.fn()}
			onToggleExpand={vi.fn()}
		/>,
	)
}

const FALLBACK = "undisplayable-message"

const subagentStatus = JSON.stringify({
	status: "running",
	total: 1,
	completed: 0,
	successes: 0,
	failures: 0,
	toolCalls: 0,
	inputTokens: 0,
	outputTokens: 0,
	contextWindow: 0,
	maxContextTokens: 0,
	maxContextUsagePercentage: 0,
	items: [
		{
			index: 1,
			prompt: "Map the repo",
			status: "running",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		},
	],
})

// One row per payload type ChatRow parses while rendering: a valid payload and the text it should show.
const rows: { name: string; make: (text: string) => ClineMessage; valid: string; shows: string; wrongShape: string }[] = [
	{
		name: "tool (say)",
		make: (text) => sayMessage("tool", text),
		valid: JSON.stringify({ tool: "readFile", path: "src/app.ts", content: "src/app.ts" }),
		shows: "PlinyCode wants to read this file:",
		wrongShape: JSON.stringify({ tool: "readFile", path: { nested: true } }),
	},
	{
		name: "tool (ask)",
		make: (text) => askMessage("tool", text),
		valid: JSON.stringify({ tool: "editedExistingFile", path: "src/app.ts", content: "patch" }),
		shows: "PlinyCode wants to edit this file:",
		wrongShape: JSON.stringify({ tool: "editedExistingFile", path: "src/app.ts", content: 42 }),
	},
	{
		name: "use_mcp_server",
		make: (text) => askMessage("use_mcp_server", text),
		valid: JSON.stringify({ type: "use_mcp_tool", serverName: "github", toolName: "list_prs", arguments: "{}" }),
		shows: "github",
		wrongShape: JSON.stringify({ type: "use_mcp_tool", serverName: ["github"] }),
	},
	{
		name: "user_feedback_diff",
		make: (text) => sayMessage("user_feedback_diff", text),
		valid: JSON.stringify({ tool: "editedExistingFile", diff: "-a\n+b" }),
		shows: "-a +b",
		wrongShape: JSON.stringify({ tool: "editedExistingFile", diff: 1 }),
	},
	{
		name: "hook_status",
		make: (text) => sayMessage("hook_status", text),
		valid: JSON.stringify({ hookName: "PreToolUse", toolName: "write_to_file", status: "completed" }),
		shows: "PreToolUse",
		wrongShape: JSON.stringify({ hookName: { name: "PreToolUse" }, status: "completed" }),
	},
	{
		name: "subagent",
		make: (text) => sayMessage("subagent", text),
		valid: subagentStatus,
		shows: "Map the repo",
		wrongShape: JSON.stringify({ status: "running", items: [{ index: 1, prompt: { text: "x" } }] }),
	},
	{
		name: "use_subagents",
		make: (text) => askMessage("use_subagents", text),
		valid: JSON.stringify({ prompts: ["Find the bug"] }),
		shows: "Find the bug",
		wrongShape: JSON.stringify({ prompts: [42] }),
	},
	{
		name: "compaction",
		make: (text) => sayMessage("compaction", text),
		valid: JSON.stringify({ status: "completed", mode: "manual" }),
		shows: "Context compacted (manual)",
		wrongShape: JSON.stringify({ status: 3 }),
	},
]

describe("ChatRow payloads", () => {
	for (const row of rows) {
		describe(row.name, () => {
			it("renders a valid payload normally", () => {
				renderRow(row.make(row.valid))
				expect(screen.getByText(row.shows, { exact: false, normalizer: (s) => s.replace(/\s+/g, " ") })).toBeTruthy()
				expect(screen.queryByTestId(FALLBACK)).toBeNull()
			})

			it("renders the fallback for truncated JSON", () => {
				renderRow(row.make(row.valid.slice(0, Math.floor(row.valid.length / 2))))
				expect(screen.getByTestId(FALLBACK)).toBeTruthy()
				expect(screen.getByText("This message could not be displayed.")).toBeTruthy()
			})

			it("renders the fallback for a payload of the wrong shape", () => {
				renderRow(row.make(row.wrongShape))
				expect(screen.getByTestId(FALLBACK)).toBeTruthy()
			})
		})
	}

	it("renders the fallback for an api_req_started row that does not parse", () => {
		renderRow(sayMessage("api_req_started", '{"request":"hi","cost":'))
		expect(screen.getByTestId(FALLBACK)).toBeTruthy()
	})

	it("renders an api_req_started row with a valid payload without the fallback", () => {
		renderRow(sayMessage("api_req_started", JSON.stringify({ request: "hi", cost: 0.01 })))
		expect(screen.queryByTestId(FALLBACK)).toBeNull()
	})

	it("still reads a followup that is not JSON as a legacy plain question", () => {
		renderRow(askMessage("followup", "Which file should I edit?"))
		expect(screen.getByText("Which file should I edit?")).toBeTruthy()
		expect(screen.queryByTestId(FALLBACK)).toBeNull()
	})

	it("shows the raw text and the error behind Details, with a copy action", () => {
		renderRow(sayMessage("tool", '{"tool":"readFile","pa'))
		expect(screen.getByRole("button", { name: "Copy message details" })).toBeTruthy()
		fireEvent.click(screen.getByRole("button", { name: "Details" }))
		const details = screen.getByText(/not valid JSON/)
		expect(details.textContent).toContain('{"tool":"readFile","pa')
		expect(details.textContent).toContain("say: tool")
	})

	it("renders a row normally once its text becomes valid", () => {
		const { rerender } = renderRow(sayMessage("tool", '{"tool":"readFile","path":"src/a'))
		expect(screen.getByTestId(FALLBACK)).toBeTruthy()
		rerender(
			<ChatRow
				isExpanded={false}
				isLast={false}
				message={sayMessage("tool", JSON.stringify({ tool: "readFile", path: "src/app.ts" }))}
				onHeightChange={vi.fn()}
				onLastRowContentChange={vi.fn()}
				onSetQuote={vi.fn()}
				onToggleExpand={vi.fn()}
			/>,
		)
		expect(screen.queryByTestId(FALLBACK)).toBeNull()
		expect(screen.getByText("PlinyCode wants to read this file:")).toBeTruthy()
	})
})
