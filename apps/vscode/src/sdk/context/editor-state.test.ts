import path from "node:path"
import { formatDisplayUserInput, formatUserInputBlock } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import {
	ConversationEditorState,
	type EditorState,
	findLastEditorStateBlock,
	formatEditorState,
	readEditorState,
} from "./editor-state"

// Absolute on every platform the tests run on.
const CWD = path.resolve("/workspace/project")
const inWorkspace = (...segments: string[]) => path.join(CWD, ...segments)

const PREAMBLE =
	"Added by the editor, not typed by the user. It shows what is open in their editor and may be unrelated to the request."

function block(...lines: string[]): string {
	return ["<editor_state>", PREAMBLE, ...lines, "</editor_state>"].join("\n")
}

describe("formatEditorState", () => {
	it("lists the active file with its cursor line and the open tabs, relative to the workspace", () => {
		const state: EditorState = {
			activeFile: inWorkspace("src", "app.ts"),
			selection: { startLine: 12, endLine: 12 },
			openTabs: [inWorkspace("src", "app.ts"), inWorkspace("README.md")],
		}

		expect(formatEditorState(state, CWD)).toBe(
			block("Active file: src/app.ts (cursor at line 12)", "Open tabs:", "- src/app.ts", "- README.md"),
		)
	})

	it("gives the selected line range", () => {
		const state: EditorState = {
			activeFile: inWorkspace("src", "app.ts"),
			selection: { startLine: 10, endLine: 24 },
			openTabs: [],
		}

		expect(formatEditorState(state, CWD)).toBe(block("Active file: src/app.ts (lines 10-24 selected)"))
	})

	it("lists at most 20 tabs and counts the rest", () => {
		const openTabs = Array.from({ length: 26 }, (_, index) => inWorkspace("src", `file-${index}.ts`))
		const lines = formatEditorState({ openTabs }, CWD)?.split("\n") ?? []

		expect(lines.filter((line) => line.startsWith("- "))).toHaveLength(20)
		expect(lines.at(-3)).toBe("- src/file-19.ts")
		expect(lines.at(-2)).toBe("... and 6 more")
	})

	it("keeps the full path of a file outside the workspace", () => {
		const outside = path.resolve("/somewhere/else/notes.md")
		const formatted = formatEditorState({ activeFile: outside, openTabs: [] }, CWD)

		expect(formatted).toContain(`Active file: ${outside.replace(/\\/g, "/")}`)
	})

	it("does not let a path read as an @ mention", () => {
		// The engine attaches the file named by a word that starts with "@".
		const formatted = formatEditorState({ openTabs: [inWorkspace("@types", "index.d.ts")] }, CWD)

		expect(formatted).toContain("- ./@types/index.d.ts")
	})

	it("is undefined when no file is open", () => {
		expect(formatEditorState({ openTabs: [] }, CWD)).toBeUndefined()
	})
})

describe("readEditorState", () => {
	it("reads the active editor and the tabs from the host bridge", async () => {
		const window = {
			getActiveEditor: vi.fn(async () => ({
				filePath: inWorkspace("src", "app.ts"),
				selectionStartLine: 3,
				selectionEndLine: 9,
				isFile: true,
			})),
			getOpenTabs: vi.fn(async () => ({ paths: [inWorkspace("src", "app.ts"), "Untitled-1"] })),
		}

		expect(await readEditorState(window)).toEqual({
			activeFile: inWorkspace("src", "app.ts"),
			selection: { startLine: 3, endLine: 9 },
			// An untitled document is not a file the model can open.
			openTabs: [inWorkspace("src", "app.ts")],
		})
	})

	it("ignores an active editor that is not a file", async () => {
		const window = {
			getActiveEditor: vi.fn(async () => ({ filePath: "extension-output-#1", selectionStartLine: 1, selectionEndLine: 1 })),
			getOpenTabs: vi.fn(async () => ({ paths: [] })),
		}

		expect(await readEditorState(window)).toEqual({ openTabs: [] })
	})
})

function makeTracker(overrides: Partial<ConstructorParameters<typeof ConversationEditorState>[0]> = {}) {
	let state: EditorState = {
		activeFile: inWorkspace("src", "app.ts"),
		selection: { startLine: 12, endLine: 12 },
		openTabs: [inWorkspace("src", "app.ts")],
	}
	const options = {
		isEnabled: vi.fn(() => true),
		read: vi.fn(async () => state),
		getCwd: vi.fn(async () => CWD),
		...overrides,
	}
	return {
		tracker: new ConversationEditorState(options),
		options,
		setState: (next: EditorState) => {
			state = next
		},
	}
}

const FIRST_BLOCK = block("Active file: src/app.ts (cursor at line 12)", "Open tabs:", "- src/app.ts")

describe("ConversationEditorState", () => {
	it("attaches a block the chat does not show", async () => {
		const { tracker } = makeTracker()

		const attached = await tracker.nextBlock("task-1")
		expect(attached).toBe(FIRST_BLOCK)

		// The message as the engine stores it, then as every display surface renders it.
		const stored = formatUserInputBlock(`fix the failing test\n\n${attached}`, "act")
		expect(formatDisplayUserInput(stored)).toBe("fix the failing test")
	})

	it("does not repeat a block that has not changed", async () => {
		const { tracker, setState } = makeTracker()

		expect(await tracker.nextBlock("task-1")).toBe(FIRST_BLOCK)
		expect(await tracker.nextBlock("task-1")).toBeUndefined()
		expect(await tracker.nextBlock("task-1")).toBeUndefined()

		// The cursor moved: that is a new block.
		setState({
			activeFile: inWorkspace("src", "app.ts"),
			selection: { startLine: 40, endLine: 40 },
			openTabs: [inWorkspace("src", "app.ts")],
		})
		expect(await tracker.nextBlock("task-1")).toContain("(cursor at line 40)")
		expect(await tracker.nextBlock("task-1")).toBeUndefined()
	})

	it("tracks each conversation separately", async () => {
		const { tracker } = makeTracker()

		expect(await tracker.nextBlock("task-1")).toBe(FIRST_BLOCK)
		expect(await tracker.nextBlock("task-2")).toBe(FIRST_BLOCK)
		expect(await tracker.nextBlock("task-1")).toBeUndefined()
	})

	it("attaches nothing with plinycode.context.editorState off", async () => {
		const isEnabled = vi.fn(() => false)
		const { tracker, options } = makeTracker({ isEnabled })

		expect(await tracker.nextBlock("task-1")).toBeUndefined()
		expect(options.read).not.toHaveBeenCalled()

		isEnabled.mockReturnValue(true)
		expect(await tracker.nextBlock("task-1")).toBe(FIRST_BLOCK)
	})

	it("says once that everything was closed, and only to a conversation that was told otherwise", async () => {
		const { tracker, setState } = makeTracker()
		setState({ openTabs: [] })

		// Nothing open from the start: nothing to say.
		expect(await tracker.nextBlock("task-1")).toBeUndefined()

		setState({ openTabs: [inWorkspace("README.md")] })
		expect(await tracker.nextBlock("task-1")).toBe(block("Open tabs:", "- README.md"))
		setState({ openTabs: [] })
		expect(await tracker.nextBlock("task-1")).toBe("<editor_state>\nNo file is open in the editor.\n</editor_state>")
		expect(await tracker.nextBlock("task-1")).toBeUndefined()
	})

	it("picks up from the transcript of a resumed conversation", async () => {
		const { tracker } = makeTracker()
		const transcript = [
			{ role: "user", content: formatUserInputBlock(`first\n\n${block("Open tabs:", "- old.ts")}`, "act") },
			{ role: "assistant", content: [{ type: "text", text: "done" }] },
			{ role: "user", content: [{ type: "text", text: formatUserInputBlock(`second\n\n${FIRST_BLOCK}`, "act") }] },
			{ role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
		]

		expect(findLastEditorStateBlock(transcript)).toBe(FIRST_BLOCK)

		// After a restart nothing is in memory; the transcript says what the model last saw.
		tracker.syncWithTranscript("task-1", transcript)
		expect(await tracker.nextBlock("task-1")).toBeUndefined()

		// A transcript without a block (new conversation, or compacted past it) starts over.
		tracker.syncWithTranscript("task-1", [{ role: "user", content: "summary of the conversation so far" }])
		expect(await tracker.nextBlock("task-1")).toBe(FIRST_BLOCK)
		tracker.syncWithTranscript("task-1", undefined)
		expect(await tracker.nextBlock("task-1")).toBe(FIRST_BLOCK)
	})

	it("attaches nothing when the editor cannot be read in time", async () => {
		const hanging = makeTracker({ read: vi.fn(() => new Promise<EditorState>(() => {})), readTimeoutMs: 20 })
		expect(await hanging.tracker.nextBlock("task-1")).toBeUndefined()

		const failing = makeTracker({ read: vi.fn().mockRejectedValue(new Error("host bridge down")) })
		expect(await failing.tracker.nextBlock("task-1")).toBeUndefined()
	})
})
