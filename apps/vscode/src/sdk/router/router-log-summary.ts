/**
 * The markdown report `scripts/summarize-free-auto-log.ts` prints from the
 * router's two logs (`pliny-free-auto-calls.jsonl`, one line per call attempt,
 * and `pliny-free-auto-runs.jsonl`, one line per run). It lives here, next to
 * the record types, so the report and the records cannot drift apart and the
 * parsing is covered by a test.
 *
 * Every field is read as optional: lines written before a field existed (the
 * token usage and cost, for instance) are counted where they can be and left
 * out of the totals they have nothing for, never rejected.
 */

import { isPlinySelfHostedModelId } from "@plinycode/llms"
import { addUsageTotals, type RouterCallLogRecord, type RouterCallLogUsage } from "./router-call-log"
import type { RouterRunLogRecord } from "./router-run-log"

type CallLine = Partial<RouterCallLogRecord> & { ts: string }
type RunLine = Partial<RouterRunLogRecord> & { ts: string }

/**
 * The JSON objects of a JSONL file that carry a string `ts`, at or after
 * `since` (an ISO time; lines are compared as ISO strings). Lines that do not
 * parse are skipped.
 */
export function parseLogLines<T extends { ts: string }>(text: string, since?: string): T[] {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.flatMap((line) => {
			try {
				const parsed: unknown = JSON.parse(line)
				return parsed && typeof parsed === "object" && typeof (parsed as { ts?: unknown }).ts === "string"
					? [parsed as T]
					: []
			} catch {
				return []
			}
		})
		.filter((record) => !since || record.ts >= since)
}

/**
 * `--since` as the ISO string log lines are compared with: a date
 * (`2026-10-01`, midnight UTC) or a full time. Undefined when it is not one.
 */
export function normalizeSince(value: string): string | undefined {
	const time = Date.parse(value)
	return Number.isNaN(time) ? undefined : new Date(time).toISOString()
}

function median(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

const percent = (part: number, whole: number) => (whole === 0 ? "—" : `${Math.round((part / whole) * 100)}%`)
const ms = (value: number | undefined) => (value === undefined ? "—" : `${Math.round(value)} ms`)

function tokens(value: number | undefined): string {
	if (value === undefined) {
		return "—"
	}
	if (value < 1000) {
		return String(Math.round(value))
	}
	return value < 1_000_000 ? `${(value / 1000).toFixed(1)}k` : `${(value / 1_000_000).toFixed(2)}M`
}

function usd(value: number | undefined): string {
	if (value === undefined) {
		return "—"
	}
	return value === 0 ? "$0" : value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`
}

function groupBy<T>(records: T[], key: (record: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>()
	for (const record of records) {
		const k = key(record)
		const group = groups.get(k)
		if (group) {
			group.push(record)
		} else {
			groups.set(k, [record])
		}
	}
	return groups
}

function sortedRows<T>(groups: Map<string, T[]>, row: (key: string, records: T[]) => string): string[] {
	return [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([key, records]) => row(key, records))
}

function table(title: string, header: string[], rows: string[]): string {
	return [`## ${title}`, "", `| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows, ""].join("\n")
}

/** A call on a paid (hosted) model; the free pool is the self-hosted one. */
function isPaidCall(record: CallLine): boolean {
	return record.model !== undefined && !isPlinySelfHostedModelId(record.model)
}

/**
 * A call's cost: the logged one, or zero for a free model whose line predates
 * the field (free models cost nothing). Undefined for a paid call without one.
 */
function callCost(record: CallLine): number | undefined {
	if (record.costUsd !== undefined) {
		return record.costUsd
	}
	return record.model !== undefined && !isPaidCall(record) ? 0 : undefined
}

// ---------------------------------------------------------------------------
// Calls: latency, outcome and shape
// ---------------------------------------------------------------------------

function callsTable(title: string, groups: Map<string, CallLine[]>): string {
	const rows = sortedRows(groups, (key, records) => {
		const ok = records.filter((r) => r.outcome === "success")
		const ttft = median(ok.flatMap((r) => (r.ttftMs === undefined ? [] : [r.ttftMs])))
		const duration = median(ok.flatMap((r) => (r.durationMs === undefined ? [] : [r.durationMs])))
		// A clean stop with text and no tool call ends the run: the share of
		// those among calls that recorded a shape is each model's stop rate.
		const shaped = ok.filter((r) => r.toolCalls !== undefined)
		const stops = shaped.filter((r) => r.toolCalls === 0 && r.finishReason === "stop")
		const textStops = shaped.length === 0 ? "—" : `${stops.length} (${percent(stops.length, shaped.length)})`
		return (
			`| ${key} | ${records.length} | ${percent(ok.length, records.length)} | ` +
			`${records.filter((r) => r.outcome === "failover").length} | ${records.filter((r) => r.outcome === "error").length} | ` +
			`${ms(ttft)} | ${ms(duration)} | ${records.filter((r) => r.effort === "think").length} | ${textStops} |`
		)
	})
	return table(
		title,
		["", "Calls", "Success", "Failovers", "Errors", "TTFT (median)", "Duration (median)", "Thinking", "Text-only stops"],
		rows,
	)
}

// ---------------------------------------------------------------------------
// Calls: tokens and cost
// ---------------------------------------------------------------------------

interface UsageSummary {
	calls: number
	withUsage: number
	usage?: RouterCallLogUsage
	cost: number
	/** Paid calls whose line carries no cost (old lines, or no usage event). */
	unpriced: number
}

function summariseUsage(records: CallLine[]): UsageSummary {
	const summary: UsageSummary = { calls: records.length, withUsage: 0, cost: 0, unpriced: 0 }
	for (const record of records) {
		if (record.usage) {
			summary.withUsage += 1
			summary.usage = addUsageTotals(summary.usage, record.usage)
		}
		const cost = callCost(record)
		if (cost === undefined) {
			summary.unpriced += 1
		} else {
			summary.cost += cost
		}
	}
	return summary
}

function usageTable(title: string, groups: Map<string, CallLine[]>): string {
	const rows = sortedRows(groups, (key, records) => {
		const s = summariseUsage(records)
		const priced = s.calls - s.unpriced
		return (
			`| ${key} | ${s.calls} | ${s.withUsage} | ${tokens(s.usage?.inputTokens)} | ${tokens(s.usage?.outputTokens)} | ` +
			`${tokens(s.usage?.cacheReadTokens)} | ${tokens(s.usage?.cacheWriteTokens)} | ${tokens(s.usage?.reasoningTokens)} | ` +
			`${usd(s.cost)}${s.unpriced > 0 ? ` (+${s.unpriced} unpriced)` : ""} | ${priced > 0 ? usd(s.cost / priced) : "—"} |`
		)
	})
	return table(
		title,
		["", "Calls", "With usage", "Input", "Output", "Cache read", "Cache write", "Reasoning", "Cost", "Cost/call"],
		rows,
	)
}

/** BalanceAuto's calls split by whether a paid or a free model answered. */
function balanceSplit(calls: CallLine[], runs: RunLine[]): string | undefined {
	const balanceCalls = calls.filter((r) => r.profile === "balance")
	if (balanceCalls.length === 0) {
		return undefined
	}
	const paid = summariseUsage(balanceCalls.filter(isPaidCall))
	const free = summariseUsage(balanceCalls.filter((r) => !isPaidCall(r)))
	const totalCost = paid.cost + free.cost
	const row = (label: string, s: UsageSummary) =>
		`| ${label} | ${s.calls} (${percent(s.calls, balanceCalls.length)}) | ${tokens(s.usage?.inputTokens)} | ` +
		`${tokens(s.usage?.outputTokens)} | ${usd(s.cost)}${s.unpriced > 0 ? ` (+${s.unpriced} unpriced)` : ""} | ${percent(s.cost, totalCost)} |`
	const lines = [
		table(
			"BalanceAuto: paid vs free calls",
			["", "Calls", "Input", "Output", "Cost", "Share of cost"],
			[row("Paid", paid), row("Free", free)],
		),
	]
	// Turns that carry the per-turn totals: how many never touched a paid model.
	const turns = runs.filter((r) => r.profile === "balance" && !r.subAgent && isSuccessfulTurn(r) && r.paidCalls !== undefined)
	if (turns.length > 0) {
		const paidTurns = turns.filter((r) => (r.paidCalls ?? 0) > 0)
		const paidTurnCost = paidTurns.reduce((sum, r) => sum + (r.paidCostUsd ?? 0), 0)
		lines.push(
			`Successful main-agent turns: ${turns.length}, ${turns.length - paidTurns.length} ` +
				`(${percent(turns.length - paidTurns.length, turns.length)}) stayed on free models; ` +
				`${paidTurns.length} used a paid model, at ${usd(paidTurns.length > 0 ? paidTurnCost / paidTurns.length : undefined)} a turn on average.\n`,
		)
	}
	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

function isSuccessfulTurn(run: RunLine): boolean {
	return run.ending === "text" || run.ending === "completion-tool"
}

/**
 * An early stop the guard did not catch: the run ended on a tool-free reply
 * right after a failed or detached command, with no reminder sent.
 */
function isUncaughtEarlyStop(run: RunLine): boolean {
	return (
		run.ending === "text" && (run.nudges ?? 0) === 0 && (run.previousToolFailed === true || run.previousToolDetached === true)
	)
}

function runsTable(title: string, groups: Map<string, RunLine[]>): string {
	const rows = sortedRows(groups, (key, records) => {
		const text = records.filter((r) => r.ending === "text")
		return (
			`| ${key} | ${records.length} | ${percent(text.length, records.length)} | ` +
			`${percent(records.filter((r) => (r.nudges ?? 0) > 0).length, records.length)} | ` +
			`${records.filter((r) => r.escalated).length} | ${records.filter((r) => r.guardGaveUp).length} | ` +
			`${records.filter((r) => r.judge === "not-done").length} | ${records.filter(isUncaughtEarlyStop).length} | ` +
			`${records.filter((r) => r.ending === "error").length} | ${median(records.map((r) => r.calls ?? 0)) ?? 0} |`
		)
	})
	return table(
		title,
		[
			"",
			"Runs",
			"Text endings",
			"Nudged",
			"Escalated",
			"Guard gave up",
			"Judge: not done",
			"Ended after failed cmd, no nudge",
			"Errors",
			"Calls/run (median)",
		],
		rows,
	)
}

/**
 * What a successful main-agent turn cost, sub-agents included. A run line
 * holds the totals of its whole turn, so the one successful line of a turn is
 * the turn; lines from before the totals existed are counted but not priced.
 */
function costPerTurnTable(runs: RunLine[]): string | undefined {
	const turns = runs.filter((r) => !r.subAgent && isSuccessfulTurn(r))
	if (turns.length === 0) {
		return undefined
	}
	const rows = sortedRows(
		groupBy(turns, (r) => r.profile ?? "?"),
		(profile, records) => {
			const priced = records.filter((r) => r.costUsd !== undefined)
			const costs = priced.map((r) => (r.costUsd ?? 0) + (r.subAgentCostUsd ?? 0))
			const total = costs.reduce((sum, cost) => sum + cost, 0)
			const turnTokens = records.flatMap((r) =>
				r.usage
					? [
							r.usage.inputTokens +
								r.usage.outputTokens +
								(r.subAgentUsage ? r.subAgentUsage.inputTokens + r.subAgentUsage.outputTokens : 0),
						]
					: [],
			)
			return (
				`| ${profile} | ${records.length} | ${priced.length} | ${usd(priced.length > 0 ? total : undefined)} | ` +
				`${usd(priced.length > 0 ? total / priced.length : undefined)} | ${usd(median(costs))} | ${tokens(median(turnTokens))} | ` +
				`${median(records.map((r) => (r.calls ?? 0) + (r.subAgentCalls ?? 0))) ?? 0} |`
			)
		},
	)
	return table(
		"Cost per successful turn (main agent, sub-agents included)",
		[
			"Profile",
			"Turns",
			"With cost",
			"Total",
			"Mean/turn",
			"Median/turn",
			"Tokens/turn (median, in+out)",
			"Calls/turn (median)",
		],
		rows,
	)
}

function rulesTable(records: RunLine[]): string {
	const counts = new Map<string, number>()
	for (const run of records) {
		for (const rule of run.guardRules ?? []) {
			counts.set(rule, (counts.get(rule) ?? 0) + 1)
		}
	}
	if (counts.size === 0) {
		return "## Guard rules fired\n\nNone.\n"
	}
	const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([rule, count]) => `| ${rule} | ${count} |`)
	return table("Guard rules fired", ["Rule", "Times"], rows)
}

function classifierTable(records: CallLine[]): string {
	const byProfile = groupBy(
		records.filter((r) => !r.subAgent),
		(r) => r.profile ?? "?",
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
	return table("Classifier verdicts (main agent)", ["Profile", "Calls with a verdict", "Turns with no verdict", "Why"], rows)
}

function tails(records: RunLine[]): string {
	const interesting = records.filter(
		(r) => r.ending === "text" && ((r.nudges ?? 0) > 0 || isUncaughtEarlyStop(r)) && r.replyTail,
	)
	if (interesting.length === 0) {
		return "## Reply tails\n\nNo nudged or suspicious endings.\n"
	}
	const lines = interesting.map(
		(r) =>
			`- \`${r.ts.slice(0, 19)}\` ${r.profile ?? "?"} · ${r.model ?? "?"} · after ${r.previousTool ?? "no tool"}` +
			`${r.previousToolFailed ? " (failed)" : r.previousToolDetached ? " (detached)" : ""}` +
			` · rules: ${(r.guardRules ?? []).join(", ") || "none"}\n  …${r.replyTail?.replace(/\n/g, " ")}`,
	)
	return ["## Reply tails", "", ...lines, ""].join("\n")
}

/** The whole report, as printed by the summary script. */
export function summarizeRouterLogs(input: {
	calls: CallLine[]
	runs: RunLine[]
	callsFile: string
	runsFile: string
	since?: string
	tails?: boolean
}): string {
	const { calls, runs, callsFile, runsFile, since } = input
	const sinceText = since ? ` since ${since}` : ""
	if (calls.length === 0 && runs.length === 0) {
		return `No FreeAuto calls logged in ${callsFile} and no runs in ${runsFile}${sinceText}.`
	}

	const sections = [
		`# FreeAuto log summary\n\n${calls.length} calls from ${callsFile}, ${runs.length} runs from ${runsFile}${sinceText}.\n`,
	]

	if (calls.length > 0) {
		const main = calls.filter((r) => !r.subAgent)
		sections.push(
			callsTable(
				"Calls by profile (main agent)",
				groupBy(main, (r) => r.profile ?? "?"),
			),
			callsTable(
				"Calls by profile and model (main agent)",
				groupBy(main, (r) => `${r.profile ?? "?"} · \`${r.model ?? "?"}\``),
			),
			callsTable(
				"Calls by route",
				groupBy(calls, (r) => `${r.profile ?? "?"} · ${r.route ?? "?"}`),
			),
			usageTable(
				"Tokens and cost by model (all calls)",
				groupBy(calls, (r) => `\`${r.model ?? "?"}\``),
			),
			usageTable(
				"Tokens and cost by route (all calls)",
				groupBy(calls, (r) => `${r.profile ?? "?"} · ${r.route ?? "?"}`),
			),
		)
		const split = balanceSplit(calls, runs)
		if (split) {
			sections.push(split)
		}
		sections.push(classifierTable(calls))
		const subAgents = calls.filter((r) => r.subAgent)
		if (subAgents.length > 0) {
			sections.push(
				callsTable(
					"Sub-agent calls by model",
					groupBy(subAgents, (r) => `\`${r.model ?? "?"}\``),
				),
			)
		}
	}

	if (runs.length > 0) {
		const main = runs.filter((r) => !r.subAgent)
		sections.push(
			runsTable(
				"Run endings by profile (main agent)",
				groupBy(main, (r) => r.profile ?? "?"),
			),
			runsTable(
				"Run endings by model (main agent)",
				groupBy(main, (r) => `\`${r.model ?? "?"}\``),
			),
			runsTable(
				"Run endings by route",
				groupBy(runs, (r) => `${r.profile ?? "?"} · ${r.route ?? "?"}`),
			),
		)
		const perTurn = costPerTurnTable(runs)
		if (perTurn) {
			sections.push(perTurn)
		}
		sections.push(rulesTable(runs))
		if (input.tails) {
			sections.push(tails(runs))
		}
	}

	return sections.join("\n")
}
