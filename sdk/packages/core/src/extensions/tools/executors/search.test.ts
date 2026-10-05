import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import { MAX_SEARCH_OUTPUT_CHARS } from "./output-limits";
import {
	createGlobMatcher,
	createSearchExecutor,
	parseRipgrepEvents,
} from "./search";

const ctx: AgentToolContext = {
	agentId: "agent-1",
	conversationId: "conv-1",
	iteration: 1,
};

/**
 * A ripgrep that cannot run, so the executor uses its own scan whether or not
 * the machine running the tests has `rg` on PATH. Lookahead patterns do the
 * same on machines that do: ripgrep rejects them.
 */
const NO_RIPGREP = path.join(os.tmpdir(), "no-such-ripgrep-binary");

async function withWorkspace(
	files: Record<string, string>,
	run: (dir: string) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			const filePath = path.join(dir, name);
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			await fs.writeFile(filePath, content, "utf-8");
		}
		await run(dir);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("createSearchExecutor", () => {
	it("middle-truncates oversized search output with recovery guidance", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		const filePath = path.join(dir, "large.ts");
		// Many matching lines so the joined output exceeds the cap even though
		// each line stays under the per-line truncation limit.
		const rows = Array.from(
			{ length: 200 },
			(_, i) => `needle ${"x".repeat(900)} row-${i}`,
		);
		await fs.writeFile(filePath, rows.join("\n"), "utf-8");

		try {
			const search = createSearchExecutor({
				contextLines: 0,
				maxMatchesPerFile: 200,
			});
			// Lookahead is unsupported by ripgrep, forcing the fallback scan.
			const result = await search("(?=needle)", dir, ctx);

			expect(result.length).toBeGreaterThan(MAX_SEARCH_OUTPUT_CHARS);
			expect(result.length).toBeLessThanOrEqual(50_000);
			expect(result).toContain("Found 100 results for pattern");
			expect(result).toContain("search output truncated");
			expect(result).toContain("Narrow the pattern or scope");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns bounded output when a match lands in a giant single-line file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agents-search-"));
		// Simulates a serialized trace dump. Buffering ripgrep's --json events
		// for such files unbounded previously crashed the host process once
		// accumulated stdout passed the engine's max string length.
		await fs.writeFile(
			path.join(dir, "trace.json"),
			`{"trace": "${"x".repeat(20 * 1024 * 1024)}"}`,
			"utf-8",
		);
		await fs.writeFile(
			path.join(dir, "small.ts"),
			"const trace = 1;\n",
			"utf-8",
		);

		try {
			const search = createSearchExecutor();
			const result = await search("trace", dir, ctx);

			expect(result.length).toBeLessThanOrEqual(50_000);
			expect(result).toContain("small.ts");
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("searches source files whatever their extension", async () => {
		await withWorkspace(
			{
				"src/engine.cc": "int Solve() {\n  return 1;\n}\n",
				"rtl/top.sv": "module top;\n  // calls Solve\nendmodule\n",
				"flow/run.tcl": "proc solve_all {} {}\n",
				"image.png": "solve\u0000binary",
			},
			async (dir) => {
				const search = createSearchExecutor({ rgPath: NO_RIPGREP });
				const result = await search("(?=solve)", dir, ctx);

				expect(result).toContain("src/engine.cc:1:5");
				expect(result).toContain("rtl/top.sv:2:12");
				expect(result).toContain("flow/run.tcl:1:6");
				expect(result).not.toContain("image.png");
			},
		);
	});

	it("shows the matching line, marked, between its context lines", async () => {
		await withWorkspace(
			{ "a.txt": "one\ntwo\nNEEDLE here\nfour\nfive\nsix\n" },
			async (dir) => {
				const search = createSearchExecutor({ contextLines: 1 });
				const result = await search("(?=needle)", dir, ctx);

				expect(result).toContain(
					["a.txt:3:1", "  2: two", "> 3: NEEDLE here", "  4: four"].join("\n"),
				);
			},
		);
	});

	it("caps the matches shown per file and names the files that have more", async () => {
		const many = Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n");
		await withWorkspace(
			{ "many.txt": many, "few.txt": "hit once\n" },
			async (dir) => {
				const search = createSearchExecutor({
					contextLines: 0,
					maxMatchesPerFile: 3,
				});
				const result = await search("(?=hit)", dir, ctx);

				expect(result).toContain("Found 4 results for pattern");
				expect(result).toContain("few.txt:1:1");
				expect(result).toContain("many.txt:3:1");
				expect(result).not.toContain("many.txt:4:1");
				expect(result).toContain(
					"(Only the first 3 matches per file are shown. More exist in: many.txt.",
				);
			},
		);
	});

	it("shows every match when the search is scoped to one file", async () => {
		const many = Array.from({ length: 30 }, (_, i) => `hit ${i}`).join("\n");
		await withWorkspace(
			{ "src/many.txt": many, "few.txt": "hit once\n" },
			async (dir) => {
				const search = createSearchExecutor({
					contextLines: 0,
					maxMatchesPerFile: 3,
				});
				const result = await search("(?=hit)", dir, ctx, {
					path: "src/many.txt",
				});

				expect(result).toContain(
					"Found 30 results for pattern: (?=hit) in src/many.txt",
				);
				expect(result).toContain("src/many.txt:30:1");
				expect(result).not.toContain("few.txt");
			},
		);
	});

	it("limits the search to a directory and to files matching a glob", async () => {
		await withWorkspace(
			{
				"src/a.ts": "needle\n",
				"src/a.test.ts": "needle\n",
				"src/deep/b.ts": "needle\n",
				"docs/a.md": "needle\n",
			},
			async (dir) => {
				const search = createSearchExecutor({ rgPath: NO_RIPGREP });

				const inSrc = await search("needle", dir, ctx, { path: "src" });
				expect(inSrc).toContain("src/a.ts:1:1");
				expect(inSrc).toContain("src/deep/b.ts:1:1");
				expect(inSrc).not.toContain("docs/a.md");

				const tests = await search("needle", dir, ctx, { glob: "*.test.ts" });
				expect(tests).toContain("Found 1 result for pattern");
				expect(tests).toContain("src/a.test.ts:1:1");

				const notMarkdown = await search("needle", dir, ctx, {
					glob: "!*.md",
				});
				expect(notMarkdown).toContain("Found 3 results for pattern");
				expect(notMarkdown).not.toContain("docs/a.md");
			},
		);
	});

	it("rejects a search path that does not exist", async () => {
		await withWorkspace({ "a.txt": "needle\n" }, async (dir) => {
			const search = createSearchExecutor({ rgPath: NO_RIPGREP });

			await expect(
				search("needle", dir, ctx, { path: "missing/dir" }),
			).rejects.toThrow("Search path not found: missing/dir");
		});
	});

	it("reports no results with the number of files it looked at", async () => {
		await withWorkspace({ "a.txt": "one\n", "b.txt": "two\n" }, async (dir) => {
			const search = createSearchExecutor({ rgPath: NO_RIPGREP });

			await expect(search("absent", dir, ctx)).resolves.toBe(
				"No results found for pattern: absent\nSearched 2 files.",
			);
		});
	});
});

describe("parseRipgrepEvents", () => {
	const event = (
		type: "context" | "match",
		file: string,
		line: number,
		text: string,
	) =>
		JSON.stringify({
			type,
			data: {
				path: { text: file },
				lines: { text: `${text}\n` },
				line_number: line,
				submatches:
					type === "match"
						? [{ match: { text: "needle" }, start: text.indexOf("needle") }]
						: [],
			},
		});
	const begin = (file: string) =>
		JSON.stringify({ type: "begin", data: { path: { text: file } } });
	const end = (file: string) =>
		JSON.stringify({ type: "end", data: { path: { text: file } } });
	const stdout = (...events: string[]) => `${events.join("\n")}\n`;
	const limits = { maxResults: 100, maxMatchesPerFile: 10, contextLines: 2 };

	it("puts the matching line and its leading context under the right file", () => {
		const { matches } = parseRipgrepEvents(
			stdout(
				begin("src\\b.ts"),
				event("context", "src\\b.ts", 2, "b2"),
				event("context", "src\\b.ts", 3, "b3"),
				event("match", "src\\b.ts", 4, "  needle three"),
				event("context", "src\\b.ts", 5, "b5"),
				end("src\\b.ts"),
				begin("a.ts"),
				event("context", "a.ts", 1, "a1"),
				event("match", "a.ts", 2, "needle one"),
				end("a.ts"),
			),
			limits,
		);

		expect(matches).toEqual([
			{
				file: "src/b.ts",
				line: 4,
				column: 3,
				match: "needle",
				context: ["  2: b2", "  3: b3", "> 4:   needle three", "  5: b5"],
			},
			{
				file: "a.ts",
				line: 2,
				column: 1,
				match: "needle",
				context: ["  1: a1", "> 2: needle one"],
			},
		]);
	});

	it("gives a line between two close matches to the first one only", () => {
		const { matches } = parseRipgrepEvents(
			stdout(
				begin("a.ts"),
				event("match", "a.ts", 1, "needle one"),
				event("context", "a.ts", 2, "between"),
				event("match", "a.ts", 3, "needle two"),
				end("a.ts"),
			),
			limits,
		);

		expect(matches.map((match) => match.context)).toEqual([
			["> 1: needle one", "  2: between"],
			["> 3: needle two"],
		]);
	});

	it("drops matches past the per-file cap and records the file", () => {
		const { matches, cappedFiles } = parseRipgrepEvents(
			stdout(
				begin("a.ts"),
				event("match", "a.ts", 1, "needle"),
				event("match", "a.ts", 2, "needle"),
				event("match", "a.ts", 3, "needle"),
				end("a.ts"),
				begin("b.ts"),
				event("match", "b.ts", 1, "needle"),
				end("b.ts"),
			),
			{ ...limits, maxMatchesPerFile: 2 },
		);

		expect(matches.map((match) => `${match.file}:${match.line}`)).toEqual([
			"a.ts:1",
			"a.ts:2",
			"b.ts:1",
		]);
		expect(cappedFiles).toEqual(["a.ts"]);
	});
});

describe("createGlobMatcher", () => {
	it("matches a bare file-name glob in any directory", () => {
		const matches = createGlobMatcher("*.ts");

		expect(matches("a.ts")).toBe(true);
		expect(matches("src/deep/a.ts")).toBe(true);
		expect(matches("src/a.tsx")).toBe(false);
	});

	it("anchors a glob with a slash at the workspace root", () => {
		const matches = createGlobMatcher("src/**/*.test.ts");

		expect(matches("src/a.test.ts")).toBe(true);
		expect(matches("src/deep/er/a.test.ts")).toBe(true);
		expect(matches("lib/src/a.test.ts")).toBe(false);
	});

	it("supports alternatives and exclusion", () => {
		expect(createGlobMatcher("*.{c,cc,h}")("src/x.cc")).toBe(true);
		expect(createGlobMatcher("*.{c,cc,h}")("src/x.cpp")).toBe(false);
		expect(createGlobMatcher("!*.md")("README.md")).toBe(false);
		expect(createGlobMatcher("!*.md")("a.ts")).toBe(true);
	});
});
