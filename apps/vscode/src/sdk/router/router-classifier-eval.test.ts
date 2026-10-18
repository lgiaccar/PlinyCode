import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { buildClassifierRequest } from "./router-classifier"
import {
	type ClassifierEvalResult,
	type ClassifierLabel,
	classifierLabelFeatures,
	classifierLabelRequest,
	formatClassifierReport,
	parseClassifierLabels,
	scoreClassifier,
} from "./router-classifier-eval"
import { defaultRules } from "./router-rules"
import { ROUTER_TIERS } from "./router-types"

const LABELS_FILE = fileURLToPath(new URL("../../../scripts/router-classifier-labels.jsonl", import.meta.url))

describe("router-classifier-labels.jsonl", () => {
	const { labels, errors } = parseClassifierLabels(readFileSync(LABELS_FILE, "utf8"))

	it("has only valid lines", () => {
		expect(errors).toEqual([])
		expect(labels.length).toBeGreaterThanOrEqual(30)
		expect(labels.length).toBeLessThanOrEqual(80)
	})

	it("covers every tier, with think both on and off", () => {
		for (const tier of ROUTER_TIERS) {
			expect(labels.filter((label) => label.expectedTier === tier).length, tier).toBeGreaterThanOrEqual(5)
		}
		expect(labels.some((label) => label.expectedThink)).toBe(true)
		expect(labels.some((label) => !label.expectedThink)).toBe(true)
		expect(labels.some((label) => label.mode === "plan")).toBe(true)
	})

	it("has no duplicate prompts", () => {
		const prompts = labels.map((label) => label.prompt.trim().toLowerCase())
		expect(new Set(prompts).size).toBe(prompts.length)
	})

	it("gives every huge label a context the huge route admits, and no other label one", () => {
		// The huge-context route only takes requests of 180k tokens or more, so a
		// huge verdict on a smaller request falls back to the heuristic routes.
		const minimum = defaultRules().routes.find((route) => route.tier === "huge")?.when?.minEstimatedTokens ?? 0
		expect(minimum).toBeGreaterThan(0)
		for (const label of labels) {
			const size = classifierLabelFeatures(label).estimatedTokens
			expect(label.expectedTier === "huge" ? size >= minimum : size < minimum, label.prompt).toBe(true)
		}
	})

	it("fits each prompt in what the classifier is sent", () => {
		const rules = defaultRules("smart")
		for (const label of labels) {
			const request = buildClassifierRequest(
				classifierLabelRequest(label),
				classifierLabelFeatures(label),
				rules,
				new AbortController().signal,
			)
			const part = request.messages[0]?.content[0]
			expect(part?.type === "text" && part.text.endsWith(label.prompt), label.prompt).toBe(true)
		}
	})
})

describe("parseClassifierLabels", () => {
	it("reports each invalid line by number and keeps the valid ones", () => {
		const text = [
			JSON.stringify({ prompt: "What is this?", expectedTier: "quick", expectedThink: false, note: "fine" }),
			"",
			"{not json",
			JSON.stringify({ prompt: "x", expectedTier: "medium", expectedThink: false, note: "bad tier" }),
			JSON.stringify({ prompt: "x", expectedTier: "code", expectedThink: "yes", note: "bad think" }),
			JSON.stringify({ prompt: "x", expectedTier: "code", expectedThink: true, note: "n", extra: 1 }),
			JSON.stringify({ prompt: "x", expectedTier: "huge", expectedThink: false, note: "n", contextTokens: -5 }),
		].join("\n")
		const { labels, errors } = parseClassifierLabels(text)
		expect(labels).toHaveLength(1)
		expect(errors).toEqual([
			"line 3: not valid JSON",
			"line 4: expectedTier must be one of quick, code, reason, huge",
			"line 5: expectedThink must be true or false",
			"line 6: unknown field(s) extra",
			"line 7: contextTokens must be a non-negative integer",
		])
	})
})

describe("scoreClassifier", () => {
	const label = (expectedTier: ClassifierLabel["expectedTier"], expectedThink: boolean): ClassifierLabel => ({
		prompt: `${expectedTier} ${expectedThink}`,
		expectedTier,
		expectedThink,
		note: "test",
	})
	const results: ClassifierEvalResult[] = [
		{ label: label("quick", false), verdict: { tier: "quick", think: false } },
		{ label: label("code", false), verdict: { tier: "code", think: true } },
		{ label: label("reason", true), verdict: { tier: "code", think: true } },
		{ label: label("huge", false), error: "timed out after 8000ms" },
	]

	it("counts tier, think and both, with no verdict as a miss", () => {
		const score = scoreClassifier(results)
		expect(score).toMatchObject({ total: 4, answered: 3, tierCorrect: 2, thinkCorrect: 2, bothCorrect: 1 })
		expect(score.tierMatrix.reason.code).toBe(1)
		expect(score.tierMatrix.huge.none).toBe(1)
		expect(score.thinkMatrix.false.true).toBe(1)
		expect(score.thinkMatrix.true.true).toBe(1)
	})

	it("lists the misses in the report", () => {
		const report = formatClassifierReport(results, "# Test")
		expect(report).toContain("| Tier | 2/4 (50%) |")
		expect(report).toContain("| reason | 0 | 1 | 0 | 0 | 0 |")
		expect(report).toContain("expected **huge**, got **no verdict (timed out after 8000ms)**")
		expect(report).not.toContain("expected **quick**")
	})
})
