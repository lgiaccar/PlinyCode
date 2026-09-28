#!/usr/bin/env bun

/**
 * Prints size metrics for the cleanup plan as markdown: source and test lines
 * per package, generated lines, and the source files over the size limit.
 *
 * Only files tracked by git are read. Source means `.ts`/`.tsx` outside tests,
 * stories, type declarations and generated code; tests are `*.test.*`,
 * `*.spec.*` and files under `__tests__/`, `test/` or `tests/`.
 *
 * Usage: bun sdk/scripts/code-metrics.ts [--top N]
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

const root = path.join(import.meta.dir, "..", "..");
const LARGE_FILE_LINES = 800;

const AREAS: Array<{ name: string; prefix: string }> = [
	{ name: "extension", prefix: "apps/vscode/src/" },
	{ name: "webview", prefix: "apps/vscode/webview-ui/src/" },
	{ name: "core", prefix: "sdk/packages/core/" },
	{ name: "llms", prefix: "sdk/packages/llms/" },
	{ name: "shared", prefix: "sdk/packages/shared/" },
	{ name: "agents", prefix: "sdk/packages/agents/" },
];

const CODE_FILE = /\.tsx?$/;
const TEST_FILE = /(\.(test|spec)\.tsx?$)|(\/(__tests__|test|tests)\/)/;
const GENERATED_FILE = /(\.generated\.ts$)|(\/generated\/)/;
const SKIPPED_FILE = /(\.d\.ts$)|(\.stories\.tsx?$)/;

type Kind = "source" | "test" | "generated";
type Totals = Record<Kind, { files: number; lines: number }>;

function classify(file: string): Kind | undefined {
	if (!CODE_FILE.test(file) || SKIPPED_FILE.test(file)) {
		return undefined;
	}
	if (GENERATED_FILE.test(file)) {
		return "generated";
	}
	return TEST_FILE.test(file) ? "test" : "source";
}

function listTrackedFiles(): string[] {
	const result = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root });
	if (result.exitCode !== 0) {
		throw new Error(`git ls-files failed: ${result.stderr.toString()}`);
	}
	return result.stdout.toString().split("\0").filter(Boolean);
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const newlines = text.match(/\n/g)?.length ?? 0;
	return text.endsWith("\n") ? newlines : newlines + 1;
}

function parseTop(args: string[]): number {
	const index = args.indexOf("--top");
	const value = index >= 0 ? Number(args[index + 1]) : 15;
	return Number.isInteger(value) && value > 0 ? value : 15;
}

async function main(): Promise<void> {
	const top = parseTop(process.argv.slice(2));
	const totals = new Map<string, Totals>();
	const largeFiles: Array<{ file: string; lines: number }> = [];

	for (const file of listTrackedFiles()) {
		const area = AREAS.find((candidate) => file.startsWith(candidate.prefix));
		const kind = area ? classify(file) : undefined;
		if (!area || !kind) {
			continue;
		}
		const lines = countLines(await readFile(path.join(root, file), "utf8"));
		const areaTotals = totals.get(area.name) ?? {
			source: { files: 0, lines: 0 },
			test: { files: 0, lines: 0 },
			generated: { files: 0, lines: 0 },
		};
		areaTotals[kind].files += 1;
		areaTotals[kind].lines += lines;
		totals.set(area.name, areaTotals);
		if (kind === "source" && lines > LARGE_FILE_LINES) {
			largeFiles.push({ file, lines });
		}
	}

	const format = (value: number) => value.toLocaleString("en-US");
	const out: string[] = [
		"| Area | Source files | Source lines | Test files | Test lines | Generated lines |",
		"| --- | ---: | ---: | ---: | ---: | ---: |",
	];
	const sum: Totals = {
		source: { files: 0, lines: 0 },
		test: { files: 0, lines: 0 },
		generated: { files: 0, lines: 0 },
	};
	for (const { name } of AREAS) {
		const t = totals.get(name);
		if (!t) {
			continue;
		}
		for (const kind of ["source", "test", "generated"] as const) {
			sum[kind].files += t[kind].files;
			sum[kind].lines += t[kind].lines;
		}
		out.push(
			`| ${name} | ${format(t.source.files)} | ${format(t.source.lines)} | ${format(t.test.files)} | ${format(t.test.lines)} | ${format(t.generated.lines)} |`,
		);
	}
	out.push(
		`| **total** | ${format(sum.source.files)} | ${format(sum.source.lines)} | ${format(sum.test.files)} | ${format(sum.test.lines)} | ${format(sum.generated.lines)} |`,
	);

	largeFiles.sort((a, b) => b.lines - a.lines);
	out.push(
		"",
		`${largeFiles.length} source files have more than ${LARGE_FILE_LINES} lines. The largest:`,
		"",
		"| Lines | File |",
		"| ---: | --- |",
		...largeFiles
			.slice(0, top)
			.map(({ file, lines }) => `| ${format(lines)} | \`${file}\` |`),
	);

	console.log(out.join("\n"));
}

await main();
