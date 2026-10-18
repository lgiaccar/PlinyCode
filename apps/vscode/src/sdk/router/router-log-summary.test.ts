import { describe, expect, it } from "vitest"
import { normalizeSince, parseLogLines, summarizeRouterLogs } from "./router-log-summary"

const KIMI = "snps-provider/kimi-k2.6"
const SONNET = "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking"

/** A call line as written before usage and cost were logged. */
const OLD_CALL = {
	ts: "2026-09-30T10:00:00.000Z",
	sessionId: "old",
	subAgent: false,
	profile: "default",
	route: "coding",
	model: KIMI,
	durationMs: 5200,
	ttftMs: 900,
	outcome: "success",
	finishReason: "tool-calls",
	textChars: 40,
	reasoningChars: 0,
	toolCalls: 1,
}

/** A run line as written before the turn totals were logged. */
const OLD_RUN = {
	ts: "2026-09-30T10:01:00.000Z",
	sessionId: "old",
	subAgent: false,
	profile: "default",
	model: KIMI,
	route: "coding",
	calls: 3,
	iterations: 3,
	ending: "text",
	toolCalls: 2,
	guardRules: [],
	nudges: 0,
	durationMs: 30000,
}

function call(overrides: Record<string, unknown>) {
	return {
		...OLD_CALL,
		ts: "2026-10-16T09:00:00.000Z",
		sessionId: "s1",
		profile: "balance",
		usage: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
		costUsd: 0,
		runId: "run-1",
		iteration: 1,
		...overrides,
	}
}

describe("parseLogLines", () => {
	it("keeps old and new lines alike and skips what is not a record", () => {
		const text = [JSON.stringify(OLD_CALL), "not json", "", "[1,2]", '{"no":"ts"}', JSON.stringify(call({}))].join("\r\n")
		const lines = parseLogLines<{ ts: string; usage?: unknown }>(text)
		expect(lines).toHaveLength(2)
		expect(lines[0]?.usage).toBeUndefined()
		expect(lines[1]?.usage).toBeDefined()
	})

	it("filters by --since, given as a date or a time", () => {
		const text = [JSON.stringify(OLD_CALL), JSON.stringify(call({}))].join("\n")
		expect(parseLogLines(text, normalizeSince("2026-10-01"))).toHaveLength(1)
		expect(parseLogLines(text, normalizeSince("2026-09-30T09:00:00Z"))).toHaveLength(2)
		expect(normalizeSince("last tuesday")).toBeUndefined()
	})
})

describe("summarizeRouterLogs", () => {
	const files = { callsFile: "calls.jsonl", runsFile: "runs.jsonl" }

	it("summarises a log of old lines only, with no usage or cost data", () => {
		const report = summarizeRouterLogs({ ...files, calls: [OLD_CALL as never], runs: [OLD_RUN as never] })
		expect(report).toContain("## Calls by profile (main agent)")
		expect(report).toContain("| default | 1 | 100% | 0 | 0 | 900 ms | 5200 ms | 0 | 0 (0%) |")
		// A free model's old line counts as free; it simply has no tokens.
		expect(report).toContain("| `snps-provider/kimi-k2.6` | 1 | 0 | — | — | — | — | — | $0 | $0 |")
		// The run is a successful turn, counted but not priced.
		expect(report).toContain("| default | 1 | 0 | — | — | — | — | 3 |")
		expect(report).not.toContain("BalanceAuto")
	})

	it("totals tokens and cost per model and route, and splits BalanceAuto into paid and free", () => {
		const calls = [
			call({ model: KIMI, route: "coding" }),
			call({
				model: SONNET,
				route: "plan-and-reasoning",
				usage: {
					inputTokens: 20_000,
					outputTokens: 2_000,
					cacheReadTokens: 15_000,
					cacheWriteTokens: 5_000,
					reasoningTokens: 700,
				},
				costUsd: 0.09,
			}),
			// A paid call whose cost is unknown (no usage event): shown as unpriced, not as $0.
			call({ model: SONNET, route: "plan-and-reasoning", outcome: "failover", usage: undefined, costUsd: undefined }),
		]
		const runs = [
			{
				...OLD_RUN,
				ts: "2026-10-16T09:01:00.000Z",
				profile: "balance",
				calls: 1,
				usage: { inputTokens: 10_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
				costUsd: 0,
				paidCalls: 0,
				models: { [KIMI]: 1 },
			},
			{
				...OLD_RUN,
				ts: "2026-10-16T09:02:00.000Z",
				profile: "balance",
				calls: 2,
				usage: { inputTokens: 20_000, outputTokens: 2_000, cacheReadTokens: 15_000, cacheWriteTokens: 5_000 },
				costUsd: 0.09,
				paidCalls: 2,
				paidCostUsd: 0.09,
				subAgentCalls: 1,
				subAgentCostUsd: 0.01,
			},
			{ ...OLD_RUN, ts: "2026-10-16T09:03:00.000Z", profile: "balance", ending: "error", costUsd: 5 },
		]
		const report = summarizeRouterLogs({ ...files, calls: calls as never, runs: runs as never })

		expect(report).toContain(
			"| `aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking` | 2 | 1 | 20.0k | 2.0k | 15.0k | 5.0k | 700 | $0.09 (+1 unpriced) | $0.09 |",
		)
		expect(report).toContain("| balance · coding | 1 | 1 | 10.0k | 500 | 0 | 0 | — | $0 | $0 |")
		expect(report).toContain("## BalanceAuto: paid vs free calls")
		expect(report).toContain("| Paid | 2 (67%) | 20.0k | 2.0k | $0.09 (+1 unpriced) | 100% |")
		expect(report).toContain("| Free | 1 (33%) | 10.0k | 500 | $0 | 0% |")
		expect(report).toContain(
			"Successful main-agent turns: 2, 1 (50%) stayed on free models; 1 used a paid model, at $0.09 a turn on average.",
		)
		// Per successful turn: the failed run is left out, the sub-agent's cost is added in.
		expect(report).toContain("| balance | 2 | 2 | $0.10 | $0.05 | $0.05 | 16.3k | 2 |")
	})

	it("lists the paid turns and counts the verdicts that left their route", () => {
		const calls = [
			call({ runId: "run-a", iteration: 1, tier: "quick", think: false, route: "coding", estimatedTokens: 41_000 }),
			call({ runId: "run-a", iteration: 2, tier: "quick", think: false, route: "coding", estimatedTokens: 42_000 }),
			call({
				runId: "run-b",
				iteration: 1,
				tier: "reason",
				think: true,
				route: "plan-and-reasoning",
				model: SONNET,
				estimatedTokens: 90_000,
			}),
			call({ runId: "run-b", iteration: 2, tier: "reason", think: true, route: "plan-and-reasoning", model: KIMI }),
		]
		const runs = [
			{ ...OLD_RUN, ts: "2026-10-16T09:01:00.000Z", profile: "balance", runId: "run-a", calls: 2, paidCalls: 0 },
			{
				...OLD_RUN,
				ts: "2026-10-16T09:02:00.000Z",
				sessionId: "1792321247419_jlbzm",
				profile: "balance",
				runId: "run-b",
				calls: 2,
				paidCalls: 1,
				paidCostUsd: 0.31,
				paidCapHit: true,
				escalatedTo: KIMI,
				models: { [SONNET]: 1, [KIMI]: 1 },
			},
		]
		const report = summarizeRouterLogs({ ...files, calls: calls as never, runs: runs as never })
		expect(report).toContain("## Classifier verdicts that left their route")
		expect(report).toContain("| balance · quick | 2 | 2 (100%) | coding (2) |")
		expect(report).toContain("| balance · reason | 2 | 0 (0%) | — |")
		expect(report).toContain("## Paid turns (main agent)")
		expect(report).toContain(
			"| 2026-10-16 09:02 | jlbzm | reason+think | plan-and-reasoning | 90.0k | 2 | 1 | $0.31 | claude-4-6-sonnet-high-thinking ×1, kimi-k2.6 ×1 | yes → kimi-k2.6 |",
		)
		expect(report).not.toContain("| 2026-10-16 09:01 |")
	})

	it("says so when there is nothing to summarise", () => {
		expect(summarizeRouterLogs({ ...files, calls: [], runs: [], since: "2026-10-01" })).toBe(
			"No FreeAuto calls logged in calls.jsonl and no runs in runs.jsonl since 2026-10-01.",
		)
	})
})
