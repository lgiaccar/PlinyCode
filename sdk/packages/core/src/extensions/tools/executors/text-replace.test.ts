import { describe, expect, it } from "vitest";
import { replaceTextInContent } from "./text-replace";

const filePath = "/repo/example.ts";

describe("replaceTextInContent", () => {
	it("replaces the single occurrence", () => {
		expect(replaceTextInContent("a\nb\nc", "b", "B", filePath)).toBe("a\nB\nc");
	});

	it("matches LF-only text in a CRLF file and keeps CRLF endings", () => {
		expect(
			replaceTextInContent("a\r\nb\r\nc\r\nd", "b\nc", "B\nC\nX", filePath),
		).toBe("a\r\nB\r\nC\r\nX\r\nd");
	});

	it("does not introduce CRLF into an LF file", () => {
		expect(replaceTextInContent("a\nb\nc", "b\r\nc", "B\r\nC", filePath)).toBe(
			"a\nB\nC",
		);
	});

	it("inserts $-sequences in the new text literally", () => {
		expect(
			replaceTextInContent("a\nb\nc", "b", "match=$& pid=$$", filePath),
		).toBe("a\nmatch=$& pid=$$\nc");
	});

	it("treats a null new text as a deletion", () => {
		expect(replaceTextInContent("keep-drop", "-drop", null, filePath)).toBe(
			"keep",
		);
	});

	it("throws when the text is absent or empty", () => {
		const notFound = `No replacement performed: text not found in ${filePath}.`;

		expect(() => replaceTextInContent("a\nb", "zzz", "x", filePath)).toThrow(
			notFound,
		);
		expect(() => replaceTextInContent("a\nb", "", "x", filePath)).toThrow(
			notFound,
		);
	});

	it("throws when the text occurs more than once", () => {
		expect(() => replaceTextInContent("a\na", "a", "x", filePath)).toThrow(
			`No replacement performed: multiple occurrences of text found in ${filePath}.`,
		);
	});
});
