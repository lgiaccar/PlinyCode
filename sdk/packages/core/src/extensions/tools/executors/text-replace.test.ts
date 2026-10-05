import { describe, expect, it } from "vitest";
import { replaceTextInContent } from "./text-replace";

const filePath = "/repo/example.ts";

function replace(
	content: string,
	oldText: string,
	newText: string,
	replaceAll?: boolean,
) {
	return replaceTextInContent(content, oldText, newText, {
		filePath,
		replaceAll,
	});
}

function errorOf(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the replacement to throw");
}

describe("replaceTextInContent", () => {
	it("replaces a single exact match and reports its line", () => {
		expect(replace("a\nb\nc", "b", "B")).toEqual({
			updated: "a\nB\nc",
			replacedAtLines: [2],
		});
	});

	it("replaces a fragment inside a line", () => {
		expect(
			replace("const total = add(a, b);", "add(a, b)", "sum").updated,
		).toBe("const total = sum;");
	});

	it("names the lines of every occurrence when old_text is ambiguous", () => {
		const message = errorOf(() => replace("x\ny\nx\nz\nx", "x", "q"));

		expect(message).toContain(
			`No replacement performed: multiple occurrences of text found in ${filePath}.`,
		);
		expect(message).toContain("3 places (lines 1, 3, 5)");
		expect(message).toContain("replace_all");
	});

	it("replaces every occurrence with replace_all", () => {
		expect(replace("x\ny\nx\nz\nx", "x", "$&q", true)).toEqual({
			updated: "$&q\ny\n$&q\nz\n$&q",
			replacedAtLines: [1, 3, 5],
		});
	});

	it("re-indents new_text when old_text was written without the file's indentation", () => {
		const content = [
			"class A {",
			"\tmethod() {",
			"\t\tif (ready) {",
			"\t\t\trun();",
			"\t\t}",
			"\t}",
			"}",
		].join("\n");

		const result = replace(
			content,
			"if (ready) {\n\trun();\n}",
			"if (ready && armed) {\n\trun();\n\tlog();\n}",
		);

		expect(result.whitespaceAdjusted).toBe("reindented");
		expect(result.replacedAtLines).toEqual([3]);
		expect(result.updated).toBe(
			[
				"class A {",
				"\tmethod() {",
				"\t\tif (ready && armed) {",
				"\t\t\trun();",
				"\t\t\tlog();",
				"\t\t}",
				"\t}",
				"}",
			].join("\n"),
		);
	});

	it("removes the extra indentation when old_text was indented deeper than the file", () => {
		const result = replace(
			"start\n  a();\n  b();\nend",
			"      a();\n      b();",
			"      a();\n      c();",
		);

		expect(result.whitespaceAdjusted).toBe("reindented");
		expect(result.updated).toBe("start\n  a();\n  c();\nend");
	});

	it("ignores trailing whitespace differences without touching indentation", () => {
		const result = replace(
			"one\n  two  \n  three\nfour",
			"  two\n  three",
			"  2\n  3",
		);

		expect(result.whitespaceAdjusted).toBe("trailing");
		expect(result.updated).toBe("one\n  2\n  3\nfour");
	});

	it("keeps CRLF endings through a whitespace-adjusted match", () => {
		const result = replace(
			"a\r\n    b();\r\n    c();\r\nd",
			"b();\nc();\n",
			"b();\nx();\n",
		);

		expect(result.updated).toBe("a\r\n    b();\r\n    x();\r\nd");
	});

	it("does not guess when tabs and spaces disagree, and shows the difference", () => {
		const message = errorOf(() =>
			replace("fn() {\n\treturn 1;\n}", "fn() {\n    return 1;\n}", "x"),
		);

		expect(message).toContain(
			`No replacement performed: text not found in ${filePath}.`,
		);
		expect(message).toContain("The closest text is at lines 1-3");
		expect(message).toContain("First difference, at line 2 (whitespace only)");
		expect(message).toContain('in the file: "\\treturn 1;"');
		expect(message).toContain('in old_text: "    return 1;"');
	});

	it("points at the closest region and the first line that differs", () => {
		const content = [
			"function total(items) {",
			"  let sum = 0;",
			"  for (const item of items) {",
			"    sum += item.price;",
			"  }",
			"  return sum;",
			"}",
		].join("\n");
		const stale = [
			"  for (const item of items) {",
			"    sum += item.cost;",
			"  }",
		].join("\n");

		const message = errorOf(() => replace(content, stale, "x"));

		expect(message).toContain(
			"The closest text is at lines 3-5 (2 of 3 old_text lines are there).",
		);
		expect(message).toContain("First difference, at line 4:");
		expect(message).toContain("in the file:     sum += item.price;");
		expect(message).toContain("in old_text:     sum += item.cost;");
		expect(message).toContain("4:     sum += item.price;");
		expect(message).toContain("Do not re-send the same old_text.");
	});

	it("finds the most similar line for a one-line old_text with a typo", () => {
		const message = errorOf(() =>
			replace(
				"alpha();\nconst timeoutMs = 5000;\nomega();",
				"const timeoutMS = 5000;",
				"x",
			),
		);

		expect(message).toContain("The closest text is at lines 2-2.");
		expect(message).toContain("2: const timeoutMs = 5000;");
	});

	it("says so when nothing in the file resembles old_text", () => {
		const message = errorOf(() =>
			replace("alpha\nbeta\ngamma", "completely different content", "x"),
		);

		expect(message).toContain("Nothing similar to old_text is in the file");
		expect(message).toContain("Read the file again");
	});

	it("refuses an indentation-only match that fits more than one place", () => {
		const content = "a {\n  go();\n}\nb {\n  go();\n}";

		const message = errorOf(() => replace(content, "    go();\n  }", "x"));

		expect(message).toContain(
			"Ignoring indentation, old_text matches at 2 places (lines 2, 5).",
		);
	});

	it("rejects an empty old_text", () => {
		expect(errorOf(() => replace("a", "", "x"))).toContain("old_text is empty");
	});
});
