/**
 * The classifier's labelled set and how it is scored.
 *
 * `scripts/router-classifier-labels.jsonl` holds hand-written requests, each
 * with the tier and think flag the routing rules intend for it.
 * `scripts/eval-router-classifier.ts` sends each one to the classifier model
 * exactly as a turn would (`buildClassifierRequest`) and reports accuracy and
 * a confusion matrix from the functions here. The label file's schema is
 * checked by `router-classifier-eval.test.ts`, which never calls the gateway.
 */

import type { AgentModelRequest } from "@plinycode/shared"
import { ROUTER_TIERS, type RouterClassification, type RouterRequestFeatures, type RouterTier } from "./router-types"

/** One labelled request. */
export interface ClassifierLabel {
	/** The latest user message, as the classifier would see it. */
	prompt: string
	expectedTier: RouterTier
	expectedThink: boolean
	/** Why this is the right label; shown next to a miss. */
	note: string
	/** Plan or act mode; act when absent. */
	mode?: "plan" | "act"
	/** Conversation size the classifier is told, in tokens; 3 000 when absent. */
	contextTokens?: number
}

const DEFAULT_CONTEXT_TOKENS = 3_000
const LABEL_KEYS = new Set(["prompt", "expectedTier", "expectedThink", "note", "mode", "contextTokens"])

/** Why a parsed line is not a valid label, or undefined when it is one. */
function labelProblem(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return "not a JSON object"
	}
	const record = value as Record<string, unknown>
	const unknown = Object.keys(record).filter((key) => !LABEL_KEYS.has(key))
	if (unknown.length > 0) {
		return `unknown field(s) ${unknown.join(", ")}`
	}
	if (typeof record.prompt !== "string" || !record.prompt.trim()) {
		return "prompt must be a non-empty string"
	}
	if (typeof record.expectedTier !== "string" || !(ROUTER_TIERS as readonly string[]).includes(record.expectedTier)) {
		return `expectedTier must be one of ${ROUTER_TIERS.join(", ")}`
	}
	if (typeof record.expectedThink !== "boolean") {
		return "expectedThink must be true or false"
	}
	if (typeof record.note !== "string" || !record.note.trim()) {
		return "note must be a non-empty string"
	}
	if (record.mode !== undefined && record.mode !== "plan" && record.mode !== "act") {
		return 'mode must be "plan" or "act"'
	}
	if (
		record.contextTokens !== undefined &&
		(typeof record.contextTokens !== "number" || !Number.isInteger(record.contextTokens) || record.contextTokens < 0)
	) {
		return "contextTokens must be a non-negative integer"
	}
	return undefined
}

/** The labels of a JSONL file, and a message for every line that is not one (1-based line numbers). */
export function parseClassifierLabels(text: string): { labels: ClassifierLabel[]; errors: string[] } {
	const labels: ClassifierLabel[] = []
	const errors: string[] = []
	text.split(/\r?\n/).forEach((line, index) => {
		if (!line.trim()) {
			return
		}
		let parsed: unknown
		try {
			parsed = JSON.parse(line)
		} catch {
			errors.push(`line ${index + 1}: not valid JSON`)
			return
		}
		const problem = labelProblem(parsed)
		if (problem) {
			errors.push(`line ${index + 1}: ${problem}`)
		} else {
			labels.push(parsed as ClassifierLabel)
		}
	})
	return { labels, errors }
}

/** What the router would know about the label's request on a turn's first call. */
export function classifierLabelFeatures(label: ClassifierLabel): RouterRequestFeatures {
	return {
		estimatedTokens: label.contextTokens ?? DEFAULT_CONTEXT_TOKENS,
		mode: label.mode ?? "act",
		prompt: label.prompt,
		hasImages: false,
		isSubAgent: false,
		callIndex: 1,
	}
}

/** The turn's request: the label's prompt as the only message. */
export function classifierLabelRequest(label: ClassifierLabel): AgentModelRequest {
	return {
		messages: [{ id: "label", role: "user", content: [{ type: "text", text: label.prompt }], createdAt: 0 }],
		tools: [],
	}
}

/** One label's outcome: the verdict, or why there was none. */
export interface ClassifierEvalResult {
	label: ClassifierLabel
	verdict?: RouterClassification
	error?: string
	durationMs?: number
}

/** Predicted column for a label without a verdict. */
const NO_VERDICT = "none"
type Predicted = RouterTier | typeof NO_VERDICT

interface ClassifierScore {
	total: number
	/** Labels the classifier answered at all. */
	answered: number
	tierCorrect: number
	thinkCorrect: number
	bothCorrect: number
	/** Rows: expected tier; columns: predicted tier, or `none` for no verdict. */
	tierMatrix: Record<RouterTier, Record<Predicted, number>>
	/** Rows: expected think; columns: predicted think (answered labels only). */
	thinkMatrix: Record<"true" | "false", Record<"true" | "false", number>>
}

export function scoreClassifier(results: readonly ClassifierEvalResult[]): ClassifierScore {
	const columns: Predicted[] = [...ROUTER_TIERS, NO_VERDICT]
	const tierMatrix = Object.fromEntries(
		ROUTER_TIERS.map((tier) => [tier, Object.fromEntries(columns.map((column) => [column, 0]))]),
	) as ClassifierScore["tierMatrix"]
	const thinkMatrix: ClassifierScore["thinkMatrix"] = { true: { true: 0, false: 0 }, false: { true: 0, false: 0 } }
	const score: ClassifierScore = {
		total: results.length,
		answered: 0,
		tierCorrect: 0,
		thinkCorrect: 0,
		bothCorrect: 0,
		tierMatrix,
		thinkMatrix,
	}
	for (const { label, verdict } of results) {
		tierMatrix[label.expectedTier][verdict?.tier ?? NO_VERDICT] += 1
		if (!verdict) {
			continue
		}
		score.answered += 1
		thinkMatrix[String(label.expectedThink) as "true" | "false"][String(verdict.think) as "true" | "false"] += 1
		const tierOk = verdict.tier === label.expectedTier
		const thinkOk = verdict.think === label.expectedThink
		score.tierCorrect += tierOk ? 1 : 0
		score.thinkCorrect += thinkOk ? 1 : 0
		score.bothCorrect += tierOk && thinkOk ? 1 : 0
	}
	return score
}

const share = (part: number, whole: number) => (whole === 0 ? "—" : `${part}/${whole} (${Math.round((part / whole) * 100)}%)`)

/** The markdown report the evaluation script prints. */
export function formatClassifierReport(results: readonly ClassifierEvalResult[], header: string): string {
	const score = scoreClassifier(results)
	const columns: Predicted[] = [...ROUTER_TIERS, NO_VERDICT]
	const lines = [
		header,
		"",
		`| | Correct |`,
		"| --- | --- |",
		`| Tier | ${share(score.tierCorrect, score.total)} |`,
		`| Think | ${share(score.thinkCorrect, score.total)} |`,
		`| Tier and think | ${share(score.bothCorrect, score.total)} |`,
		`| Answered at all | ${share(score.answered, score.total)} |`,
		"",
		"## Tier confusion (rows: expected, columns: classifier)",
		"",
		`| expected \\ got | ${columns.join(" | ")} |`,
		`| --- | ${columns.map(() => "---").join(" | ")} |`,
		...ROUTER_TIERS.map((tier) => `| ${tier} | ${columns.map((column) => score.tierMatrix[tier][column]).join(" | ")} |`),
		"",
		"## Think confusion (answered labels)",
		"",
		"| expected \\ got | true | false |",
		"| --- | --- | --- |",
		`| true | ${score.thinkMatrix.true.true} | ${score.thinkMatrix.true.false} |`,
		`| false | ${score.thinkMatrix.false.true} | ${score.thinkMatrix.false.false} |`,
		"",
	]
	const misses = results.filter(
		({ label, verdict }) => !verdict || verdict.tier !== label.expectedTier || verdict.think !== label.expectedThink,
	)
	lines.push("## Misses", "")
	if (misses.length === 0) {
		lines.push("None.", "")
	} else {
		for (const { label, verdict, error } of misses) {
			const expected = `${label.expectedTier}${label.expectedThink ? "+think" : ""}`
			const got = verdict ? `${verdict.tier}${verdict.think ? "+think" : ""}` : `no verdict (${error ?? "unknown"})`
			lines.push(`- expected **${expected}**, got **${got}**: ${label.prompt.slice(0, 100)} _(${label.note})_`)
		}
		lines.push("")
	}
	return lines.join("\n")
}
