import { describe, expect, it } from "vitest"
import { countCheckpointLineChanges, getCheckpointFileChangeStatus, normalizeContentLineEndings } from "./checkpoint-line-diff"

describe("checkpoint-line-diff", () => {
	it("classifies added, modified, and deleted files", () => {
		expect(getCheckpointFileChangeStatus("", "new")).toBe("added")
		expect(getCheckpointFileChangeStatus("old", "")).toBe("deleted")
		expect(getCheckpointFileChangeStatus("a", "b")).toBe("modified")
	})

	it("counts line changes for a simple edit", () => {
		expect(countCheckpointLineChanges("a\nb\n", "a\nc\n")).toEqual({ added: 1, removed: 1 })
	})

	it("treats CRLF and LF consistently", () => {
		const crlf = "line1\r\nline2\r\n"
		const lf = "line1\nline2\n"
		expect(normalizeContentLineEndings(crlf)).toBe(lf)
		expect(countCheckpointLineChanges(crlf, lf)).toEqual({ added: 0, removed: 0 })
	})

	it("handles trailing newline differences via diffLines semantics", () => {
		expect(countCheckpointLineChanges("a\n", "a")).toEqual({ added: 1, removed: 1 })
		expect(countCheckpointLineChanges("a", "a\n")).toEqual({ added: 1, removed: 1 })
	})
})
