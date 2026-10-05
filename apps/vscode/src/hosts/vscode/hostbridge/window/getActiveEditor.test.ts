import { afterEach, describe, expect, it } from "vitest"
import * as vscode from "vscode"
import { getActiveEditor } from "./getActiveEditor"

interface FakeSelection {
	start: { line: number; character: number }
	end: { line: number; character: number }
}

function setActiveEditor(editor: unknown): void {
	;(vscode.window as { activeTextEditor: unknown }).activeTextEditor = editor
}

function fileEditor(
	selection: FakeSelection,
	uri: { scheme: string; fsPath: string } = { scheme: "file", fsPath: "/repo/src/app.ts" },
) {
	const isEmpty = selection.start.line === selection.end.line && selection.start.character === selection.end.character
	return { document: { uri, isUntitled: uri.scheme === "untitled" }, selection: { ...selection, isEmpty } }
}

describe("Hostbridge - Window - getActiveEditor", () => {
	afterEach(() => setActiveEditor(undefined))

	it("returns nothing when no editor is active", async () => {
		expect(await getActiveEditor({})).toEqual({ filePath: undefined })
	})

	it("reports the cursor as a 1-based line", async () => {
		setActiveEditor(fileEditor({ start: { line: 11, character: 4 }, end: { line: 11, character: 4 } }))

		expect(await getActiveEditor({})).toEqual({
			filePath: "/repo/src/app.ts",
			selectionStartLine: 12,
			selectionEndLine: 12,
			isFile: true,
		})
	})

	it("reports the selected lines", async () => {
		setActiveEditor(fileEditor({ start: { line: 9, character: 2 }, end: { line: 23, character: 7 } }))

		expect(await getActiveEditor({})).toMatchObject({ selectionStartLine: 10, selectionEndLine: 24 })
	})

	it("does not count the line a whole-line selection ends in front of", async () => {
		// Lines 10-24 selected by dragging the gutter: the end sits at column 0 of line 25.
		setActiveEditor(fileEditor({ start: { line: 9, character: 0 }, end: { line: 24, character: 0 } }))

		expect(await getActiveEditor({})).toMatchObject({ selectionStartLine: 10, selectionEndLine: 24 })
	})

	it("marks untitled documents and output channels as not being files", async () => {
		const cursor = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

		setActiveEditor(fileEditor(cursor, { scheme: "untitled", fsPath: "Untitled-1" }))
		expect(await getActiveEditor({})).toMatchObject({ filePath: "Untitled-1", isFile: false })

		setActiveEditor(fileEditor(cursor, { scheme: "output", fsPath: "extension-output-#1" }))
		expect(await getActiveEditor({})).toMatchObject({ isFile: false })

		setActiveEditor(fileEditor(cursor, { scheme: "vscode-remote", fsPath: "/home/dev/repo/app.ts" }))
		expect(await getActiveEditor({})).toMatchObject({ isFile: true })
	})
})
