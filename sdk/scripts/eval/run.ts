#!/usr/bin/env bun
/**
 * PlinyCode eval harness runner. See ./README.md and docs/eval-harness.md.
 *
 *   bun sdk/scripts/eval/run.ts                 # every case, offline playback
 *   bun sdk/scripts/eval/run.ts --case create   # cases whose id contains "create"
 *   bun --use-system-ca sdk/scripts/eval/run.ts --record --case create-file
 *
 * Writes one JSON line per case to ai_output/eval/results-<timestamp>.jsonl
 * and exits non-zero when any case fails.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { setClineDir, setHomeDir, setInstructionHost } from "@plinycode/core";
import { type AssertionResult, checkAssertions } from "./lib/assertions";
import { type EvalCase, loadCases } from "./lib/cases";
import {
	collectToolErrors,
	removeWorkspace,
	runCaseSession,
	type VcrRunMode,
} from "./lib/session";

const EVAL_DIR = import.meta.dir;
const REPO_ROOT = resolve(EVAL_DIR, "..", "..", "..");
const CASES_DIR = join(EVAL_DIR, "cases");
const FIXTURES_DIR = join(EVAL_DIR, "fixtures");

interface CaseResultLine {
	id: string;
	passed: boolean;
	assertions: AssertionResult[];
	iterations: number;
	toolCalls: number;
	toolErrors: number;
	usage: { input: number; output: number; cost: number };
	wallMs: number;
	finishReason: string;
	mode: VcrRunMode;
	model: string;
	tags: string[];
	cassette: { used: number; total: number };
	error?: string;
}

function usage(exitCode: number): never {
	console.log(`Usage: bun sdk/scripts/eval/run.ts [options]

Options:
  --offline         Play every case back from its cassette.json (default)
  --record          Run against the live Pliny gateway (needs PLINY_API_KEY)
                    and overwrite each selected case's cassette.json
  --case <text>     Only cases whose id contains <text> (repeatable)
  --tag <tag>       Only cases with this tag (repeatable)
  --out <dir>       Results directory (default: ai_output/eval)
  --keep            Keep the temp workspaces and print their paths
  --list            List the cases and exit
  -h, --help        Show this help`);
	process.exit(exitCode);
}

function selectCases(
	cases: EvalCase[],
	ids: string[],
	tags: string[],
): EvalCase[] {
	return cases.filter(
		(evalCase) =>
			(ids.length === 0 || ids.some((id) => evalCase.id.includes(id))) &&
			(tags.length === 0 || tags.some((tag) => evalCase.tags.includes(tag))),
	);
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function printSummary(lines: CaseResultLine[]): void {
	const idWidth = Math.max(4, ...lines.map((line) => line.id.length));
	const header = `${pad("case", idWidth)}  result  iter  tools  errs  tokens in/out    cost      wall`;
	console.log(`\n${header}\n${"-".repeat(header.length)}`);
	for (const line of lines) {
		const tokens = `${line.usage.input}/${line.usage.output}`;
		console.log(
			[
				pad(line.id, idWidth),
				pad(line.passed ? "PASS" : "FAIL", 6),
				pad(String(line.iterations), 4),
				pad(String(line.toolCalls), 5),
				pad(String(line.toolErrors), 4),
				pad(tokens, 15),
				pad(`$${line.usage.cost.toFixed(4)}`, 9),
				`${(line.wallMs / 1000).toFixed(1)}s`,
			].join("  "),
		);
		if (!line.passed) {
			if (line.error) {
				console.log(`    run: ${line.error}`);
			}
			for (const assertion of line.assertions.filter((a) => !a.passed)) {
				console.log(`    ${assertion.type}: ${assertion.detail}`);
			}
		}
		if (line.cassette.used < line.cassette.total && line.mode === "playback") {
			console.log(
				`    note: the run used ${line.cassette.used} of ${line.cassette.total} cassette responses`,
			);
		}
	}
	const passed = lines.filter((line) => line.passed).length;
	console.log(`\n${passed}/${lines.length} case(s) passed`);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		strict: true,
		options: {
			offline: { type: "boolean" },
			record: { type: "boolean" },
			case: { type: "string", multiple: true },
			tag: { type: "string", multiple: true },
			out: { type: "string" },
			keep: { type: "boolean" },
			list: { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (values.help) {
		usage(0);
	}
	if (values.offline && values.record) {
		console.error("--offline and --record are mutually exclusive");
		usage(2);
	}
	const vcrMode: VcrRunMode = values.record ? "record" : "playback";
	const cases = selectCases(
		loadCases(CASES_DIR, FIXTURES_DIR),
		values.case ?? [],
		values.tag ?? [],
	);
	if (values.list) {
		for (const evalCase of cases) {
			console.log(
				`${evalCase.id}  [${evalCase.tags.join(", ")}]  ${evalCase.model}`,
			);
		}
		return;
	}
	if (cases.length === 0) {
		console.error("No case matches the --case/--tag filters.");
		process.exit(2);
	}
	const apiKey =
		vcrMode === "record" ? process.env.PLINY_API_KEY?.trim() : undefined;
	if (vcrMode === "record" && !apiKey) {
		console.error("--record needs PLINY_API_KEY in the environment.");
		process.exit(2);
	}

	// Keep the engine away from the user's ~/.cline (sessions, settings, MCP
	// servers, global rules and skills): everything it reads or persists goes
	// to a throwaway home. CLINE_* variables point at other settings files,
	// and the OneDrive ones at a redirected Documents folder with global rules.
	const workRoot = mkdtempSync(join(tmpdir(), "plinycode-eval-"));
	const home = join(workRoot, "home");
	mkdirSync(home, { recursive: true });
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("CLINE_") || /^onedrive/i.test(key)) {
			delete process.env[key];
		}
	}
	setHomeDir(home);
	setClineDir(join(home, ".cline"));
	setInstructionHost({ globalRulesDirectory: join(home, ".cline", "rules") });

	const outDir = resolve(values.out ?? join(REPO_ROOT, "ai_output", "eval"));
	mkdirSync(outDir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const resultsPath = join(outDir, `results-${stamp}.jsonl`);
	writeFileSync(resultsPath, "");

	console.log(
		`Running ${cases.length} case(s) in ${vcrMode === "record" ? "record (live gateway)" : "offline playback"} mode`,
	);
	const lines: CaseResultLine[] = [];
	for (const evalCase of cases) {
		console.log(`\n> ${evalCase.id}`);
		const run = await runCaseSession(evalCase, {
			vcrMode,
			workRoot,
			fixturesDir: FIXTURES_DIR,
			apiKey,
		});
		const toolErrors = collectToolErrors(run.result);
		const assertions = checkAssertions(evalCase.assertions, run.workspace, {
			iterations: run.result?.iterations ?? 0,
			finalText: run.result?.text ?? "",
			toolErrors,
		});
		const finishReason = run.timedOut
			? "timeout"
			: (run.result?.finishReason ?? "error");
		const line: CaseResultLine = {
			id: evalCase.id,
			passed:
				!run.error &&
				finishReason === "completed" &&
				assertions.every((assertion) => assertion.passed),
			assertions,
			iterations: run.result?.iterations ?? 0,
			toolCalls: run.result?.toolCalls.length ?? 0,
			toolErrors: toolErrors.length,
			usage: {
				input: run.result?.usage.inputTokens ?? 0,
				output: run.result?.usage.outputTokens ?? 0,
				cost: run.result?.usage.totalCost ?? 0,
			},
			wallMs: run.wallMs,
			finishReason,
			mode: vcrMode,
			model: evalCase.model,
			tags: evalCase.tags,
			cassette: run.cassette,
			...(run.error ? { error: run.error } : {}),
		};
		if (!run.error && finishReason !== "completed") {
			const text = run.result?.text.trim();
			line.error = `the agent stopped with finishReason=${finishReason}${
				finishReason === "error" && text ? `: ${text.slice(0, 300)}` : ""
			}`;
		}
		lines.push(line);
		writeFileSync(resultsPath, `${JSON.stringify(line)}\n`, { flag: "a" });
		console.log(`  ${line.passed ? "PASS" : "FAIL"} (${finishReason})`);
		if (values.keep) {
			console.log(`  workspace: ${run.workspace}`);
		} else {
			removeWorkspace(run.workspace);
		}
	}

	printSummary(lines);
	console.log(
		`Results: ${relative(process.cwd(), resultsPath) || resultsPath}`,
	);
	if (!values.keep) {
		try {
			rmSync(workRoot, { recursive: true, force: true, maxRetries: 3 });
		} catch {
			// On Windows the engine's session database in the throwaway home is
			// still open until the process exits; the OS temp dir reclaims it.
		}
	}
	process.exit(lines.every((line) => line.passed) ? 0 : 1);
}

await main();
