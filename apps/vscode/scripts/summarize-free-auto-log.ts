#!/usr/bin/env bun
/**
 * Summarise the FreeAuto logs written next to the rules files, so profiles and
 * models can be compared on real use:
 *
 * - `pliny-free-auto-calls.jsonl`: one line per model call (latency, failovers,
 *   classifier verdicts).
 * - `pliny-free-auto-runs.jsonl`: one line per run (how it ended, whether the
 *   completion guard or judge had to step in, what the last tool was). This is
 *   where early stops show up: a run that ended on a tool-free reply right
 *   after a failed command, or that needed a reminder, is an early stop the
 *   guard did or did not catch.
 *
 * Usage:  bun scripts/summarize-free-auto-log.ts [path/to/pliny-free-auto-calls.jsonl]
 *             [--runs path/to/pliny-free-auto-runs.jsonl] [--since 2026-09-24] [--tails]
 */

import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

interface CallRecord {
	ts: string
	profile: string
	route: string
	model: string
	effort?: string
	tier?: string
	think?: boolean
	classifierError?: string
	subAgent: boolean
	ttftMs?: number
	durationMs: number
	outcome: "success" | "failover" | "error"
}

interface RunRecord {
	ts: string
	profile: string
	model?: string
	route?: string
	subAgent: boolean
	calls: number
	iterations: number
	ending: "text" | "completion-tool" | "error" | "aborted"
	toolCalls: number
	previousTool?: string
	previousToolFailed?: boolean
	previousToolDetached?: boolean
	guardRules: string[]
	nudges: number
	escalated?: boolean
	judge?: "done" | "not-done" | "no-verdict" | "skipped"
	replyChars?: number
	replyTail?: string
	durationMs: number
}

function dataDir(): string {
	return (
		process.env.CLINE_DATA_DIR ??
		(process.env.CLINE_DIR ? path.join(process.env.CLINE_DIR, "data") : path.join(os.homedir(), ".cline", "data"))
	)
}

function median(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

const percent = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`)
const ms = (value: number | undefined) => (value === undefined ? "—" : `${value} ms`)

function summariseCalls(records: CallRecord[]) {
	const ok = records.filter((r) => r.outcome === "success")
	return {
		calls: records.length,
		success: percent(ok.length, records.length),
		failovers: records.filter((r) => r.outcome === "failover").length,
		errors: records.filter((r) => r.outcome === "error").length,
		ttft: ms(median(ok.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs])))),
		duration: ms(median(ok.map((r) => r.durationMs))),
		think: records.filter((r) => r.effort === "think").length,
	}
}

function callsTable(title: string, groups: Map<string, CallRecord[]>): string {
	const rows = [...groups.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([key, records]) => {
			const s = summariseCalls(records)
			return `| ${key} | ${s.calls} | ${s.success} | ${s.failovers} | ${s.errors} | ${s.ttft} | ${s.duration} | ${s.think} |`
		})
	return [
		`## ${title}`,
		"",
		"| | Calls | Success | Failovers | Errors | TTFT (median) | Duration (median) | Thinking |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n")
}

/**
 * An early stop the guard did not catch: the run ended on a tool-free reply
 * right after a failed or detached command, with no reminder sent.
 */
function isUncaughtEarlyStop(run: RunRecord): boolean {
	return run.ending === "text" && run.nudges === 0 && (run.previousToolFailed === true || run.previousToolDetached === true)
}

function summariseRuns(records: RunRecord[]) {
	const text = records.filter((r) => r.ending === "text")
	return {
		runs: records.length,
		text: percent(text.length, records.length),
		nudged: percent(records.filter((r) => r.nudges > 0).length, records.length),
		escalated: records.filter((r) => r.escalated).length,
		judgeNotDone: records.filter((r) => r.judge === "not-done").length,
		afterFailed: records.filter(isUncaughtEarlyStop).length,
		errors: records.filter((r) => r.ending === "error").length,
		calls: median(records.map((r) => r.calls)) ?? 0,
	}
}

function runsTable(title: string, groups: Map<string, RunRecord[]>): string {
	const rows = [...groups.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([key, records]) => {
			const s = summariseRuns(records)
			return `| ${key} | ${s.runs} | ${s.text} | ${s.nudged} | ${s.escalated} | ${s.judgeNotDone} | ${s.afterFailed} | ${s.errors} | ${s.calls} |`
		})
	return [
		`## ${title}`,
		"",
		"| | Runs | Text endings | Nudged | Escalated | Judge: not done | Ended after failed cmd, no nudge | Errors | Calls/run (median) |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n")
}

function rulesTable(records: RunRecord[]): string {
	const counts = new Map<string, number>()
	for (const run of records) {
		for (const rule of run.guardRules) {
			counts.set(rule, (counts.get(rule) ?? 0) + 1)
		}
	}
	if (counts.size === 0) {
		return "## Guard rules fired\n\nNone.\n"
	}
	const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([rule, count]) => `| ${rule} | ${count} |`)
	return ["## Guard rules fired", "", "| Rule | Times |", "| --- | --- |", ...rows, ""].join("\n")
}

function classifierTable(records: CallRecord[]): string {
	const byProfile = groupBy(
		records.filter((r) => !r.subAgent),
		(r) => r.profile,
	)
	const rows = [...byProfile.entries()].map(([profile, calls]) => {
		const withVerdict = calls.filter((r) => r.tier !== undefined).length
		const failures = calls.filter((r) => r.classifierError).length
		const reasons = new Map<string, number>()
		for (const call of calls) {
			if (call.classifierError) {
				const key = call.classifierError.split(":")[0]
				reasons.set(key, (reasons.get(key) ?? 0) + 1)
			}
		}
		const why = [...reasons.entries()].map(([reason, count]) => `${reason} ×${count}`).join(", ")
		return `| ${profile} | ${percent(withVerdict, calls.length)} | ${failures} | ${why || "—"} |`
	})
	return [
		"## Classifier verdicts (main agent)",
		"",
		"| Profile | Calls with a verdict | Turns with no verdict | Why |",
		"| --- | --- | --- | --- |",
		...rows,
		"",
	].join("\n")
}

function tails(records: RunRecord[]): string {
	const interesting = records.filter((r) => r.ending === "text" && (r.nudges > 0 || isUncaughtEarlyStop(r)) && r.replyTail)
	if (interesting.length === 0) {
		return "## Reply tails\n\nNo nudged or suspicious endings.\n"
	}
	const lines = interesting.map(
		(r) =>
			`- \`${r.ts.slice(0, 19)}\` ${r.profile} · ${r.model ?? "?"} · after ${r.previousTool ?? "no tool"}` +
			`${r.previousToolFailed ? " (failed)" : r.previousToolDetached ? " (detached)" : ""}` +
			` · rules: ${r.guardRules.join(", ") || "none"}\n  …${r.replyTail?.replace(/\n/g, " ")}`,
	)
	return ["## Reply tails", "", ...lines, ""].join("\n")
}

function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>()
	for (const record of records) {
		const k = key(record)
		groups.set(k, [...(groups.get(k) ?? []), record])
	}
	return groups
}

async function readJsonl<T extends { ts: string }>(file: string, since: string | undefined): Promise<T[]> {
	const text = await readFile(file, "utf8").catch(() => "")
	return text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as T]
			} catch {
				return []
			}
		})
		.filter((record) => !since || record.ts >= since)
}

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const since = optionValue(args, "--since")
	const runsOption = optionValue(args, "--runs")
	const consumed = new Set([since, runsOption].filter(Boolean))
	const callsFile =
		args.find((arg) => !arg.startsWith("--") && !consumed.has(arg)) ?? path.join(dataDir(), "pliny-free-auto-calls.jsonl")
	const runsFile = runsOption ?? path.join(path.dirname(callsFile), "pliny-free-auto-runs.jsonl")

	const calls = await readJsonl<CallRecord>(callsFile, since)
	const runs = await readJsonl<RunRecord>(runsFile, since)

	if (calls.length === 0 && runs.length === 0) {
		console.log(`No FreeAuto calls logged in ${callsFile} and no runs in ${runsFile}${since ? ` since ${since}` : ""}.`)
		return
	}

	console.log(
		`# FreeAuto log summary\n\n${calls.length} calls from ${callsFile}, ${runs.length} runs from ${runsFile}${since ? ` since ${since}` : ""}.\n`,
	)

	if (calls.length > 0) {
		const main = calls.filter((r) => !r.subAgent)
		console.log(
			callsTable(
				"Calls by profile (main agent)",
				groupBy(main, (r) => r.profile),
			),
		)
		console.log(
			callsTable(
				"Calls by profile and model (main agent)",
				groupBy(main, (r) => `${r.profile} · \`${r.model}\``),
			),
		)
		console.log(
			callsTable(
				"Calls by route",
				groupBy(calls, (r) => `${r.profile} · ${r.route}`),
			),
		)
		console.log(classifierTable(calls))
		const subAgents = calls.filter((r) => r.subAgent)
		if (subAgents.length > 0) {
			console.log(
				callsTable(
					"Sub-agent calls by model",
					groupBy(subAgents, (r) => `\`${r.model}\``),
				),
			)
		}
	}

	if (runs.length > 0) {
		const main = runs.filter((r) => !r.subAgent)
		console.log(
			runsTable(
				"Run endings by profile (main agent)",
				groupBy(main, (r) => r.profile),
			),
		)
		console.log(
			runsTable(
				"Run endings by model (main agent)",
				groupBy(main, (r) => `\`${r.model ?? "?"}\``),
			),
		)
		console.log(
			runsTable(
				"Run endings by route",
				groupBy(runs, (r) => `${r.profile} · ${r.route ?? "?"}`),
			),
		)
		console.log(rulesTable(runs))
		if (args.includes("--tails")) {
			console.log(tails(runs))
		}
	}
}

await main()
