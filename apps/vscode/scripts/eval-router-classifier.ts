#!/usr/bin/env bun
/**
 * Measure the router classifier against the hand-labelled set in
 * `scripts/router-classifier-labels.jsonl`: each label's prompt is sent to the
 * classifier model exactly as a turn's first call would send it
 * (`buildClassifierRequest` + `runClassifier`, with the profile's built-in
 * rules), and the verdicts are scored for tier and think accuracy, with a
 * confusion matrix and the list of misses.
 *
 * Live runs call the Pliny gateway, one label at a time (the gateway answers
 * bursts with 429). Each result is also written to
 * `ai_output/eval/classifier-<timestamp>.jsonl` at the repository root.
 *
 * Usage:
 *   bun scripts/eval-router-classifier.ts --dry-run [--limit 3]
 *   PLINY_API_KEY=... bun --use-system-ca scripts/eval-router-classifier.ts
 *       [--labels <file>] [--profile smart|balance] [--model <classifier id>]
 *       [--timeout <ms>] [--delay <ms>] [--limit <n>] [--tier quick|code|reason|huge]
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { createGateway } from "@plinycode/llms"
import { buildClassifierRequest, runClassifier } from "../src/sdk/router/router-classifier"
import {
	type ClassifierEvalResult,
	classifierLabelFeatures,
	classifierLabelRequest,
	formatClassifierReport,
	parseClassifierLabels,
} from "../src/sdk/router/router-classifier-eval"
import { defaultRules } from "../src/sdk/router/router-rules"

const scriptDir = import.meta.dir
const repoRoot = path.resolve(scriptDir, "..", "..", "..")

function optionValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

function numberOption(args: string[], name: string): number | undefined {
	const value = optionValue(args, name)
	if (value === undefined) {
		return undefined
	}
	const parsed = Number(value)
	if (!Number.isFinite(parsed) || parsed < 0) {
		console.error(`${name} expects a non-negative number; got "${value}".`)
		process.exit(2)
	}
	return parsed
}

async function main(): Promise<void> {
	const args = process.argv.slice(2)
	const labelsFile = optionValue(args, "--labels") ?? path.join(scriptDir, "router-classifier-labels.jsonl")
	const profile = optionValue(args, "--profile") ?? "smart"
	const rules = defaultRules(profile)
	const modelId = optionValue(args, "--model") ?? rules.utility.classifier
	const timeoutMs = numberOption(args, "--timeout") ?? rules.classifier.timeoutMs
	const delayMs = numberOption(args, "--delay") ?? 250
	const limit = numberOption(args, "--limit")
	const tier = optionValue(args, "--tier")
	const dryRun = args.includes("--dry-run")

	const { labels: allLabels, errors } = parseClassifierLabels(await readFile(labelsFile, "utf8"))
	if (errors.length > 0) {
		console.error(`${labelsFile} has invalid lines:\n${errors.join("\n")}`)
		process.exit(1)
	}
	const filtered = tier ? allLabels.filter((label) => label.expectedTier === tier) : allLabels
	const labels = limit === undefined ? filtered : filtered.slice(0, limit)
	const evalRules = { ...rules, classifier: { ...rules.classifier, timeoutMs } }

	if (dryRun) {
		const signal = new AbortController().signal
		console.log(`# Classifier requests (dry run)\n\n${labels.length} labels from ${labelsFile}, model ${modelId}.\n`)
		labels.forEach((label, index) => {
			const sent = buildClassifierRequest(classifierLabelRequest(label), classifierLabelFeatures(label), evalRules, signal)
			if (index === 0) {
				console.log(`## System prompt\n\n${sent.systemPrompt}\n\n## Options\n\n${JSON.stringify(sent.options)}\n`)
			}
			const text = sent.messages[0]?.content.map((part) => (part.type === "text" ? part.text : "")).join("") ?? ""
			console.log(`## ${index + 1}. expected ${label.expectedTier}${label.expectedThink ? "+think" : ""}\n\n${text}\n`)
		})
		return
	}

	const apiKey = process.env.PLINY_API_KEY
	if (!apiKey) {
		console.error("PLINY_API_KEY is not set. Set it, or pass --dry-run to see what would be sent.")
		process.exit(2)
	}
	const gateway = createGateway({
		providerConfigs: [
			{ providerId: "pliny", apiKey, ...(process.env.PLINY_BASE_URL ? { baseUrl: process.env.PLINY_BASE_URL } : {}) },
		],
	})
	const model = gateway.createAgentModel({ providerId: "pliny", modelId })

	const results: ClassifierEvalResult[] = []
	for (const [index, label] of labels.entries()) {
		const startedAt = Date.now()
		const outcome = await runClassifier({
			model,
			request: classifierLabelRequest(label),
			features: classifierLabelFeatures(label),
			rules: evalRules,
		})
		const result: ClassifierEvalResult = {
			label,
			...(outcome.classification ? { verdict: outcome.classification } : {}),
			...(outcome.error ? { error: outcome.error } : {}),
			durationMs: Date.now() - startedAt,
		}
		results.push(result)
		const got = result.verdict
			? `${result.verdict.tier}${result.verdict.think ? "+think" : ""}`
			: `no verdict (${result.error})`
		console.error(
			`[${index + 1}/${labels.length}] ${label.expectedTier}${label.expectedThink ? "+think" : ""} → ${got} (${result.durationMs} ms)`,
		)
		if (delayMs > 0 && index < labels.length - 1) {
			await new Promise((resolve) => setTimeout(resolve, delayMs))
		}
	}

	const outDir = path.join(repoRoot, "ai_output", "eval")
	await mkdir(outDir, { recursive: true })
	const outFile = path.join(outDir, `classifier-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
	await writeFile(outFile, `${results.map((result) => JSON.stringify({ model: modelId, ...result })).join("\n")}\n`, "utf8")

	console.log(
		formatClassifierReport(
			results,
			`# Classifier evaluation\n\n${labels.length} labels from ${labelsFile}, model \`${modelId}\` (${profile} rules, ` +
				`${timeoutMs} ms timeout). Results: ${outFile}`,
		),
	)
}

await main()
