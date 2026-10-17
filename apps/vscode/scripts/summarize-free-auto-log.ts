#!/usr/bin/env bun
/**
 * Summarise the FreeAuto logs written next to the rules files, so profiles and
 * models can be compared on real use:
 *
 * - `pliny-free-auto-calls.jsonl`: one line per model call (latency, failovers,
 *   classifier verdicts, tokens and cost).
 * - `pliny-free-auto-runs.jsonl`: one line per run (how it ended, whether the
 *   completion guard or judge had to step in, what the last tool was, and the
 *   turn's tokens and cost). This is where early stops show up: a run that
 *   ended on a tool-free reply right after a failed command, or that needed a
 *   reminder, is an early stop the guard did or did not catch.
 *
 * The report itself is built by `src/sdk/router/router-log-summary.ts`.
 *
 * Usage:  bun scripts/summarize-free-auto-log.ts [path/to/pliny-free-auto-calls.jsonl]
 *             [--runs path/to/pliny-free-auto-runs.jsonl] [--since 2026-09-24] [--tails]
 */

import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normalizeSince, parseLogLines, summarizeRouterLogs } from "../src/sdk/router/router-log-summary"

function dataDir(): string {
	return (
		process.env.CLINE_DATA_DIR ??
		(process.env.CLINE_DIR ? path.join(process.env.CLINE_DIR, "data") : path.join(os.homedir(), ".cline", "data"))
	)
}

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const sinceOption = optionValue(args, "--since")
	const runsOption = optionValue(args, "--runs")
	const since = sinceOption === undefined ? undefined : normalizeSince(sinceOption)
	if (sinceOption !== undefined && since === undefined) {
		console.error(`--since expects a date or an ISO time, such as 2026-10-01; got "${sinceOption}".`)
		process.exit(2)
	}
	const consumed = new Set([sinceOption, runsOption].filter(Boolean))
	const callsFile =
		args.find((arg) => !arg.startsWith("--") && !consumed.has(arg)) ?? path.join(dataDir(), "pliny-free-auto-calls.jsonl")
	const runsFile = runsOption ?? path.join(path.dirname(callsFile), "pliny-free-auto-runs.jsonl")

	const read = (file: string) => readFile(file, "utf8").catch(() => "")
	console.log(
		summarizeRouterLogs({
			calls: parseLogLines(await read(callsFile), since),
			runs: parseLogLines(await read(runsFile), since),
			callsFile,
			runsFile,
			...(sinceOption ? { since: sinceOption } : {}),
			tails: args.includes("--tails"),
		}),
	)
}

await main()
