import { describe, it } from "bun:test"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { expect } from "chai"
import { DEFAULT_MAX_OUTPUT_LINES, renderConversationMarkdown } from "../markdown"

const HISTORY_ITEM: HistoryItem = {
	id: "task-1",
	ts: 1_700_000_000_000,
	task: "Add a markdown export\nwith a second line that must not reach the H1",
	tokensIn: 0,
	tokensOut: 0,
	totalCost: 0,
	modelId: "pliny/claude-opus-5",
	apiProvider: "pliny",
	cwdOnTaskInitialization: "/workspace/demo",
}

/**
 * One fixture covering every branch the renderer has to get right: user text,
 * assistant text, reasoning, a file edit, a command with output, an
 * api_req_started row that must stay out of the body but feed the metrics, and
 * internal rows that must vanish entirely.
 */
const MESSAGES: ClineMessage[] = [
	{ ts: 1, type: "say", say: "task", text: "Add a markdown export", images: ["/tmp/shots/screenshot.png"] },
	{
		ts: 2,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({ tokensIn: 1200, tokensOut: 340, cacheWrites: 50, cacheReads: 900, cost: 0.0123 }),
	},
	{ ts: 3, type: "say", say: "reasoning", text: "The renderer should stay pure." },
	{ ts: 4, type: "say", say: "text", text: "I'll add a `renderConversationMarkdown` helper." },
	{
		ts: 5,
		type: "ask",
		ask: "tool",
		text: JSON.stringify({ tool: "editedExistingFile", path: "src/core/export/markdown.ts" }),
	},
	{
		ts: 6,
		type: "say",
		say: "tool",
		text: JSON.stringify({
			tool: "editedExistingFile",
			path: "src/core/export/markdown.ts",
			content: "------- SEARCH\nold\n=======\nnew\n+++++++ REPLACE",
		}),
	},
	{ ts: 7, type: "say", say: "checkpoint_created" },
	{ ts: 8, type: "say", say: "command", text: "bun test\nOutput:\nok 1 renders\nok 2 truncates", commandCompleted: true },
	{ ts: 9, type: "say", say: "user_feedback", text: "Looks good, ship it." },
	{ ts: 10, type: "say", say: "completion_result", text: "Added the exporter and its tests." },
]

function render(messages: ClineMessage[], options = {}) {
	return renderConversationMarkdown(HISTORY_ITEM, messages, {
		formatDate: () => "2023-11-14 22:13 UTC",
		plinyCodeVersion: "1.2.3",
		...options,
	})
}

describe("renderConversationMarkdown", () => {
	it("renders the full conversation with tool output and reasoning off", () => {
		expect(render(MESSAGES)).to.equal(EXPECTED_WITHOUT_REASONING)
	})

	it("renders reasoning in a collapsed details block when asked", () => {
		const markdown = render(MESSAGES, { includeReasoning: true })
		expect(markdown).to.contain("<details>\n<summary>Reasoning</summary>\n\nThe renderer should stay pure.\n\n</details>")
	})

	it("omits reasoning by default", () => {
		expect(render(MESSAGES)).to.not.contain("The renderer should stay pure.")
	})

	it("drops tool and command output when includeToolOutput is false", () => {
		const markdown = render(MESSAGES, { includeToolOutput: false })
		expect(markdown).to.contain("Edited `src/core/export/markdown.ts`")
		expect(markdown).to.not.contain("+++++++ REPLACE")
		expect(markdown).to.contain("Ran `bun test`")
		expect(markdown).to.not.contain("ok 1 renders")
	})

	it("fences a multi-line command but not a one-liner", () => {
		const oneLiner = render([{ ts: 1, type: "say", say: "command", text: "ls -la\nOutput:\ntotal 0" }])
		expect(oneLiner).to.contain("Ran `ls -la`")
		expect(oneLiner).to.not.contain("```shell\nls -la\n```")

		const multiLine = render([{ ts: 1, type: "say", say: "command", text: "cd src \\\n  && ls\nOutput:\ntotal 0" }])
		expect(multiLine).to.contain("Ran `cd src \\`")
		expect(multiLine).to.contain("```shell\ncd src \\\n  && ls\n```")
	})

	it("truncates long output at maxOutputLines and says how much was dropped", () => {
		const output = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n")
		const markdown = render([{ ts: 1, type: "say", say: "command", text: `ls\nOutput:\n${output}` }], {
			maxOutputLines: 3,
		})
		expect(markdown).to.contain("line 3\n... truncated (7 more lines)")
		expect(markdown).to.not.contain("line 4")
	})

	it("uses a singular truncation marker for a single dropped line", () => {
		const markdown = render([{ ts: 1, type: "say", say: "command", text: "ls\nOutput:\na\nb" }], { maxOutputLines: 1 })
		expect(markdown).to.contain("... truncated (1 more line)")
	})

	it("sums metrics across api_req_started, deleted_api_reqs and subagent_usage rows", () => {
		const markdown = render([
			...MESSAGES,
			{ ts: 11, type: "say", say: "deleted_api_reqs", text: JSON.stringify({ tokensIn: 300, cost: 0.01 }) },
			{ ts: 12, type: "say", say: "subagent_usage", text: JSON.stringify({ tokensOut: 60, cost: 0.002 }) },
		])
		expect(markdown).to.contain("| **Tokens in** | 1,500 |")
		expect(markdown).to.contain("| **Tokens out** | 400 |")
		expect(markdown).to.contain("| **Cost** | $0.0243 |")
	})

	it("skips internal rows entirely", () => {
		const markdown = render([
			{ ts: 1, type: "say", say: "task", text: "hi" },
			{ ts: 2, type: "say", say: "checkpoint_created" },
			{ ts: 3, type: "say", say: "compaction", text: JSON.stringify({ status: "completed", mode: "auto" }) },
			{ ts: 4, type: "say", say: "subagent", text: JSON.stringify({ status: "running", items: [] }) },
			{ ts: 5, type: "say", say: "task_progress", text: "1/3 done" },
		])
		expect(markdown).to.not.contain("## PlinyCode")
		expect(markdown).to.not.contain("1/3 done")
	})

	it("skips partial rows, which duplicate a final row with the same ts", () => {
		const markdown = render([
			{ ts: 1, type: "say", say: "task", text: "hi" },
			{ ts: 2, type: "say", say: "text", text: "partial deliv", partial: true },
			{ ts: 2, type: "say", say: "text", text: "partial delivered" },
		])
		expect(markdown).to.contain("partial delivered")
		expect(markdown).to.not.contain("partial deliv\n")
	})

	it("references images by filename and never inlines base64", () => {
		const markdown = render([
			{
				ts: 1,
				type: "say",
				say: "task",
				text: "look",
				images: ["C:\\shots\\bug.png", "data:image/png;base64,AAAABBBBCCCC"],
				files: ["notes.txt"],
			},
		])
		expect(markdown).to.contain("_Images: `bug.png`, `embedded image/png image`_")
		expect(markdown).to.contain("_Files: `notes.txt`_")
		expect(markdown).to.not.contain("AAAABBBBCCCC")
	})

	it("widens the fence so output containing backticks cannot break out", () => {
		const markdown = render([{ ts: 1, type: "say", say: "command", text: "echo\nOutput:\n```\nnested\n```" }])
		expect(markdown).to.contain("````shell\n```\nnested\n```\n````")
	})

	it("defaults maxOutputLines to 200", () => {
		const output = Array.from({ length: DEFAULT_MAX_OUTPUT_LINES + 1 }, (_, index) => `l${index}`).join("\n")
		const markdown = render([{ ts: 1, type: "say", say: "command", text: `ls\nOutput:\n${output}` }])
		expect(markdown).to.contain("... truncated (1 more line)")
	})

	it("falls back to a generic title when the task text is empty", () => {
		const markdown = renderConversationMarkdown({ ...HISTORY_ITEM, task: "" }, [], {
			formatDate: () => "2023-11-14 22:13 UTC",
		})
		expect(markdown.split("\n")[0]).to.equal("# PlinyCode Conversation")
		expect(markdown).to.contain("| **Exported by** | PlinyCode |")
	})
})

/** Snapshot of the default render. Keep in sync deliberately, not reflexively. */
const EXPECTED_WITHOUT_REASONING = `# Add a markdown export

| | |
| --- | --- |
| **Date** | 2023-11-14 22:13 UTC |
| **Workspace** | /workspace/demo |
| **Model** | pliny/claude-opus-5 |
| **Provider** | pliny |
| **Tokens in** | 1,200 |
| **Tokens out** | 340 |
| **Cache writes** | 50 |
| **Cache reads** | 900 |
| **Cost** | $0.0123 |
| **Exported by** | PlinyCode 1.2.3 |

## User

Add a markdown export

_Images: \`screenshot.png\`_

## PlinyCode

I'll add a \`renderConversationMarkdown\` helper.

Edited \`src/core/export/markdown.ts\`

\`\`\`diff
------- SEARCH
old
=======
new
+++++++ REPLACE
\`\`\`

Ran \`bun test\`

\`\`\`shell
ok 1 renders
ok 2 truncates
\`\`\`

## User

Looks good, ship it.

## PlinyCode

Added the exporter and its tests.
`
