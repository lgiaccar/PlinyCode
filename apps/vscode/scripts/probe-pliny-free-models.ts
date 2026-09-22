#!/usr/bin/env bun
/**
 * Probe the free Pliny models so FreeAuto's default pool order is based on
 * measurement rather than guesswork.
 *
 * For each free (`snps-provider*`) model in the catalog it measures:
 *   - whether the model answers at all, and with what HTTP status
 *   - whether it really performs a tool call when given one
 *   - time to first token, and output tokens per second
 *
 * Writes a JSON report next to the catalog and a Markdown matrix under docs/.
 * Nothing in the extension reads these files at runtime; they exist so a human
 * can justify the default ordering and spot models that have gone bad.
 *
 * Usage:  PLINY_API_KEY=... bun scripts/probe-pliny-free-models.ts [--runs 3]
 */

import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import catalog from "../../../sdk/packages/llms/src/providers/data/pliny-models.json"

interface CatalogEntry {
	id: string
	context?: number
	tool_call?: boolean
	note?: string
}

interface RunSample {
	ok: boolean
	status: number
	ttftMs?: number
	totalMs?: number
	outputTokens?: number
	tokensPerSecond?: number
	toolCalled?: boolean
	error?: string
}

interface ModelReport {
	id: string
	contextWindow: number
	note?: string
	samples: RunSample[]
	/** Median of the successful samples, the number worth ranking on. */
	medianTtftMs?: number
	medianTokensPerSecond?: number
	successRate: number
	toolCallRate: number
}

const API_KEY = process.env.PLINY_API_KEY
const BASE_URL = process.env.PLINY_BASE_URL ?? catalog.baseURL
const RUNS = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 3
const REQUEST_TIMEOUT_MS = 120_000

/** A prompt that forces a tool call, so tool support is observed and not assumed. */
const TOOL_PROBE = {
	messages: [
		{
			role: "user" as const,
			content: "What is the weather in Dublin? Use the get_weather tool. Then reply with one short sentence.",
		},
	],
	tools: [
		{
			type: "function" as const,
			function: {
				name: "get_weather",
				description: "Get the current weather for a city",
				parameters: {
					type: "object",
					properties: { city: { type: "string", description: "City name" } },
					required: ["city"],
				},
			},
		},
	],
}

function freeModels(): CatalogEntry[] {
	return (catalog.selfHosted as CatalogEntry[]).filter((entry) => entry.tool_call)
}

function median(values: number[]): number | undefined {
	if (values.length === 0) {
		return undefined
	}
	const sorted = [...values].sort((a, b) => a - b)
	const mid = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

async function probeOnce(modelId: string): Promise<RunSample> {
	const startedAt = Date.now()
	let ttftMs: number | undefined
	let outputTokens = 0
	let toolCalled = false

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

	try {
		const response = await fetch(`${BASE_URL}/chat/completions`, {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
				...(catalog.headers as Record<string, string>),
			},
			body: JSON.stringify({
				model: modelId,
				stream: true,
				max_tokens: 256,
				messages: TOOL_PROBE.messages,
				tools: TOOL_PROBE.tools,
				tool_choice: "auto",
			}),
		})

		if (!response.ok || !response.body) {
			return {
				ok: false,
				status: response.status,
				error: (await response.text().catch(() => "")).slice(0, 200),
			}
		}

		const reader = response.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		for (;;) {
			const { done, value } = await reader.read()
			if (done) {
				break
			}
			buffer += decoder.decode(value, { stream: true })
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) {
				const trimmed = line.trim()
				if (!trimmed.startsWith("data:")) {
					continue
				}
				const payload = trimmed.slice(5).trim()
				if (!payload || payload === "[DONE]") {
					continue
				}
				try {
					const chunk = JSON.parse(payload)
					const delta = chunk.choices?.[0]?.delta
					if (delta?.tool_calls) {
						toolCalled = true
					}
					if (delta?.content || delta?.tool_calls) {
						ttftMs ??= Date.now() - startedAt
						outputTokens += 1
					}
				} catch {
					// Partial JSON across chunk boundaries is expected; skip it.
				}
			}
		}

		const totalMs = Date.now() - startedAt
		const streamMs = Math.max(1, totalMs - (ttftMs ?? 0))
		return {
			ok: outputTokens > 0,
			status: response.status,
			ttftMs,
			totalMs,
			outputTokens,
			tokensPerSecond: Number(((outputTokens / streamMs) * 1000).toFixed(1)),
			toolCalled,
			...(outputTokens === 0 ? { error: "stream produced no output" } : {}),
		}
	} catch (error) {
		return {
			ok: false,
			status: 0,
			error: error instanceof Error ? error.message : String(error),
		}
	} finally {
		clearTimeout(timeout)
	}
}

async function probeModel(entry: CatalogEntry): Promise<ModelReport> {
	const samples: RunSample[] = []
	for (let run = 0; run < RUNS; run += 1) {
		samples.push(await probeOnce(entry.id))
	}
	const ok = samples.filter((sample) => sample.ok)
	return {
		id: entry.id,
		contextWindow: entry.context ?? 0,
		...(entry.note ? { note: entry.note } : {}),
		samples,
		medianTtftMs: median(ok.map((sample) => sample.ttftMs ?? 0).filter(Boolean)),
		medianTokensPerSecond: median(ok.map((sample) => sample.tokensPerSecond ?? 0).filter(Boolean)),
		successRate: Number((ok.length / samples.length).toFixed(2)),
		toolCallRate: Number((samples.filter((s) => s.toolCalled).length / samples.length).toFixed(2)),
	}
}

function renderMarkdown(reports: ModelReport[]): string {
	const ranked = [...reports].sort((a, b) => {
		if (a.successRate !== b.successRate) {
			return b.successRate - a.successRate
		}
		return (a.medianTtftMs ?? Number.MAX_SAFE_INTEGER) - (b.medianTtftMs ?? Number.MAX_SAFE_INTEGER)
	})

	const rows = ranked
		.map((report) => {
			const ttft = report.medianTtftMs ? `${report.medianTtftMs} ms` : "—"
			const tps = report.medianTokensPerSecond ? `${report.medianTokensPerSecond}` : "—"
			const context = report.contextWindow ? `${Math.round(report.contextWindow / 1000)}k` : "—"
			const health =
				report.successRate === 1 ? "healthy" : report.successRate === 0 ? "**down**" : `flaky (${report.successRate})`
			return `| \`${report.id}\` | ${context} | ${health} | ${report.toolCallRate} | ${ttft} | ${tps} |`
		})
		.join("\n")

	return `# Pliny free model probe

Measured against the live gateway on ${new Date().toISOString().slice(0, 10)}, ${RUNS} run(s) per model.
Regenerate with:

\`\`\`sh
PLINY_API_KEY=... bun apps/vscode/scripts/probe-pliny-free-models.ts --runs 3
\`\`\`

"Tool rate" is the fraction of runs in which the model actually emitted a tool
call when given one — the single most important property for agentic use, and
the reason a model with a great token rate may still be a poor default.

| Model | Context | Health | Tool rate | TTFT (median) | tok/s (median) |
| --- | --- | --- | --- | --- | --- |
${rows}

## How this feeds the router

The default pool order in the generated rules file favours, in order: models
that answer reliably, models that really call tools, then latency. A model that
shows as **down** here is still left in the catalog (it may recover), but the
router benches it automatically after repeated failures at runtime.
`
}

async function main(): Promise<void> {
	if (!API_KEY) {
		console.error("PLINY_API_KEY is not set; cannot probe the gateway.")
		process.exit(1)
	}

	const models = freeModels()
	console.error(`Probing ${models.length} free models at ${BASE_URL} (${RUNS} run(s) each)...`)

	const reports: ModelReport[] = []
	for (const [index, entry] of models.entries()) {
		process.stderr.write(`  [${index + 1}/${models.length}] ${entry.id} ... `)
		const report = await probeModel(entry)
		reports.push(report)
		const status =
			report.successRate === 0
				? `DOWN (${report.samples[0]?.status || "?"}: ${report.samples[0]?.error?.slice(0, 60) ?? ""})`
				: `ok ttft=${report.medianTtftMs ?? "?"}ms tools=${report.toolCallRate}`
		console.error(status)
	}

	const repoRoot = path.resolve(import.meta.dir, "../../..")
	const jsonPath = path.join(repoRoot, "sdk/packages/llms/src/providers/data/pliny-free-auto-probe.json")
	const mdPath = path.join(repoRoot, "docs/pliny-free-auto-router.md")

	await writeFile(
		jsonPath,
		`${JSON.stringify({ probedAt: new Date().toISOString(), baseURL: BASE_URL, runs: RUNS, reports }, null, 2)}\n`,
	)
	await mkdir(path.dirname(mdPath), { recursive: true })
	await writeFile(mdPath, renderMarkdown(reports))

	console.error(`\nWrote ${jsonPath}`)
	console.error(`Wrote ${mdPath}`)
}

await main()
