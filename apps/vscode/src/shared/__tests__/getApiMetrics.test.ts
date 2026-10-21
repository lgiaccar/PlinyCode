import { describe, it } from "bun:test"
import { strict as assert } from "node:assert"
import type { ClineMessage } from "../ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens, getLastPrunedTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
	it("includes subagent_usage in aggregate totals", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 10,
					tokensOut: 20,
					cacheWrites: 3,
					cacheReads: 1,
					cost: 0.12,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 4,
					tokensOut: 8,
					cacheWrites: 2,
					cacheReads: 1,
					cost: 0.05,
				}),
			},
			{
				ts: 3,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({
					tokensIn: 6,
					tokensOut: 9,
					cacheWrites: 1,
					cacheReads: 0,
					cost: 0.03,
				}),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 20)
		assert.equal(metrics.totalTokensOut, 37)
		assert.equal(metrics.totalCacheWrites, 6)
		assert.equal(metrics.totalCacheReads, 2)
		assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
	})

	it("flags hasEstimatedUsage when any summed request was a char-based estimate", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 10, tokensOut: 20, cost: 0 }),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 500, tokensOut: 50, estimated: true }),
			},
		]

		const metrics = getApiMetrics(messages)

		assert.equal(metrics.totalTokensIn, 510)
		assert.equal(metrics.totalTokensOut, 70)
		assert.equal(metrics.hasEstimatedUsage, true)
	})

	it("leaves hasEstimatedUsage unset when every request reported real usage", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 10, tokensOut: 20, cost: 0.01 }),
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.hasEstimatedUsage, undefined)
	})

	it("ignores malformed usage payloads", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: "{not-json",
			},
		]

		const metrics = getApiMetrics(messages)
		assert.equal(metrics.totalTokensIn, 0)
		assert.equal(metrics.totalTokensOut, 0)
		assert.equal(metrics.totalCost, 0)
	})
})

describe("getLastApiReqTotalTokens", () => {
	it("uses only the latest api_req_started payload", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "subagent_usage",
				text: JSON.stringify({
					source: "subagents",
					tokensIn: 100,
					tokensOut: 200,
				}),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 11,
					tokensOut: 7,
					cacheWrites: 2,
					cacheReads: 3,
				}),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 16)
	})

	it("scales the last request by the shrink ratio of a compaction completed after it", () => {
		// The compaction counters are the SDK's estimate — a different scale from
		// the provider-reported request total. Only the ratio carries over.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 90_000, tokensOut: 5_000, cacheReads: 5_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 23_750)
	})

	it("compounds multiple compactions completed since the last request", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 100_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 200_000, tokensAfter: 100_000 }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 100_000, tokensAfter: 50_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 25_000)
	})

	it("grows the request total when a compaction made the estimated context larger", () => {
		// Compacting a tiny conversation can produce a summary bigger than the
		// original messages. The header must follow the divider's direction
		// instead of freezing at the pre-compaction value.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 4_000, tokensOut: 1_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 1_000, tokensAfter: 1_300 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 5_200)
	})

	it("leaves the request total unscaled when a completed compaction lacks token counters", () => {
		// The coordinator's fallback divider carries only message counts.
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 40_000, tokensOut: 2_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", messagesBefore: 40, messagesAfter: 6 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 40_000)
	})

	it("returns 0 when a compaction completed but no request preceded it", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "manual", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 0)
	})

	it("ignores compaction rows without a usable compacted size", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 11, tokensOut: 7, cacheWrites: 2, cacheReads: 3 }),
			},
			{
				ts: 2,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "started", mode: "auto" }),
			},
			{
				ts: 3,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "failed", mode: "auto" }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 16)
	})

	it("prefers a request newer than the last compaction", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "compaction",
				text: JSON.stringify({ status: "completed", mode: "auto", tokensBefore: 95_000, tokensAfter: 30_000 }),
			},
			{
				ts: 2,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 31_000, tokensOut: 1_000 }),
			},
		]

		const total = getLastApiReqTotalTokens(messages)
		assert.equal(total, 31_000)
	})
})

describe("getLastApiReqTotalTokens input-only count", () => {
	it("counts the request's input, not the reply's output", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 50_000, tokensOut: 20_000, cacheReads: 30_000 }),
			},
		]
		assert.equal(getLastApiReqTotalTokens(messages), 80_000)
	})

	it("prefers the request's own input over counts that billed a retried empty reply", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				// Two attempts of a 60k request were billed; the request is 60k.
				text: JSON.stringify({ tokensIn: 120_000, tokensOut: 900, contextTokens: 60_000 }),
			},
		]
		assert.equal(getLastApiReqTotalTokens(messages), 60_000)
	})
})

describe("getLastPrunedTokens", () => {
	it("reads what the last request with usage left out, skipping the row that only marks a start", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ tokensIn: 40_000, prunedTokens: 12_000 }),
			},
			{ ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ request: "..." }) },
		]
		assert.equal(getLastPrunedTokens(messages), 12_000)
		messages.push({ ts: 3, type: "say", say: "api_req_started", text: JSON.stringify({ tokensIn: 30_000 }) })
		assert.equal(getLastPrunedTokens(messages), 0)
	})
})
