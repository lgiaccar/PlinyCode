#!/usr/bin/env bun
/**
 * Summarise the FreeAuto call log (`pliny-free-auto-calls.jsonl`, written next
 * to the rules files) so profiles and models can be compared on real use.
 *
 * Usage:  bun scripts/summarize-free-auto-log.ts [path/to/pliny-free-auto-calls.jsonl] [--since 2026-09-24]
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
	subAgent: boolean
	ttftMs?: number
	durationMs: number
	outcome: "success" | "failover" | "error"
}

function defaultLogPath(): string {
	const dataDir =
		process.env.CLINE_DATA_DIR ??
		(process.env.CLINE_DIR ? path.join(process.env.CLINE_DIR, "data") : path.join(os.homedir(), ".cline", "data"))
	return path.join(dataDir, "pliny-free-auto-calls.jsonl")
}

function median(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function summarise(records: CallRecord[]) {
	const ok = records.filter((r) => r.outcome === "success")
	const ms = (value: number | undefined) => (value === undefined ? "—" : `${value} ms`)
	return {
		calls: records.length,
		success: `${Math.round((ok.length / records.length) * 100)}%`,
		failovers: records.filter((r) => r.outcome === "failover").length,
		errors: records.filter((r) => r.outcome === "error").length,
		ttft: ms(median(ok.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs])))),
		duration: ms(median(ok.map((r) => r.durationMs))),
		think: records.filter((r) => r.effort === "think").length,
	}
}

function table(title: string, groups: Map<string, CallRecord[]>): string {
	const rows = [...groups.entries()]
		.sort((a, b) => b[1].length - a[1].length)
		.map(([key, records]) => {
			const s = summarise(records)
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

function groupBy(records: CallRecord[], key: (record: CallRecord) => string): Map<string, CallRecord[]> {
	const groups = new Map<string, CallRecord[]>()
	for (const record of records) {
		const k = key(record)
		groups.set(k, [...(groups.get(k) ?? []), record])
	}
	return groups
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const sinceIndex = args.indexOf("--since")
	const since = sinceIndex >= 0 ? args[sinceIndex + 1] : undefined
	const file = args.find((arg, index) => !arg.startsWith("--") && index !== sinceIndex + 1) ?? defaultLogPath()

	const text = await readFile(file, "utf8").catch(() => "")
	const records = text
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as CallRecord]
			} catch {
				return []
			}
		})
		.filter((record) => !since || record.ts >= since)

	if (records.length === 0) {
		console.log(`No FreeAuto calls logged in ${file}${since ? ` since ${since}` : ""}.`)
		return
	}

	const main = records.filter((r) => !r.subAgent)
	console.log(`# FreeAuto call log summary\n\n${records.length} calls from ${file}${since ? ` since ${since}` : ""}.\n`)
	console.log(
		table(
			"By profile (main agent)",
			groupBy(main, (r) => r.profile),
		),
	)
	console.log(
		table(
			"By profile and model (main agent)",
			groupBy(main, (r) => `${r.profile} · \`${r.model}\``),
		),
	)
	console.log(
		table(
			"By route",
			groupBy(records, (r) => `${r.profile} · ${r.route}`),
		),
	)
	const subAgents = records.filter((r) => r.subAgent)
	if (subAgents.length > 0) {
		console.log(
			table(
				"Sub-agents by model",
				groupBy(subAgents, (r) => `\`${r.model}\``),
			),
		)
	}
}

await main()
