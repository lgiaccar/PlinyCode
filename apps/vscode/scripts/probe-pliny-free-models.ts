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
 * With --thinking it instead measures, per model, whether it reasons by default
 * and which request fields turn reasoning on or off. The result is what the
 * `thinking` entries in pliny-models.json are copied from.
 *
 * Usage:  PLINY_API_KEY=... bun scripts/probe-pliny-free-models.ts [--runs 3] [--thinking] [--only <substring>]
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
const THINKING = process.argv.includes("--thinking")
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : undefined
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
	return (catalog.selfHosted as CatalogEntry[]).filter((entry) => entry.tool_call && (!ONLY || entry.id.includes(ONLY)))
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

// ---------------------------------------------------------------------------
// --thinking: which request fields switch reasoning on and off
// ---------------------------------------------------------------------------

/** A question small models answer instantly but reasoning models deliberate over. */
const THINKING_PROMPT =
	"A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. " +
	"How much does the ball cost? Reply with just the amount."

/** Body patches tried on every model. Names are what the catalog records. */
const THINKING_VARIANTS: Record<string, Record<string, unknown>> = {
	baseline: {},
	"effort-high": { reasoning_effort: "high" },
	"template-on": { chat_template_kwargs: { enable_thinking: true } },
	"effort-none": { reasoning_effort: "none" },
	"template-off": { chat_template_kwargs: { enable_thinking: false } },
	"reasoning-exclude": { reasoning: { exclude: true } },
}

interface ThinkingSample {
	status: number
	ok: boolean
	/** Reasoning characters, from reasoning_content/reasoning deltas or an inline <think> block. */
	reasoningChars: number
	reasoningTokens?: number
	contentChars: number
	/** Time to the first visible answer character. */
	ttftMs?: number
	totalMs?: number
	error?: string
}

type ThinkingOff = "template-kwargs" | "reasoning-effort-none" | "reasoning-exclude"
type ThinkingOn = "reasoning-effort" | "template-kwargs"

interface ThinkingReport {
	id: string
	variants: Record<string, ThinkingSample>
	/** Reasons with no hint at all. */
	defaultOn: boolean
	/** The first field that reliably silenced reasoning, when it was on by default. */
	off?: ThinkingOff
	/** The first field that produced reasoning, when it was off by default. */
	on?: ThinkingOn
	/** Variants the gateway rejected outright (4xx). Sending these would fail the call. */
	rejected: string[]
}

async function probeThinkingOnce(modelId: string, patch: Record<string, unknown>): Promise<ThinkingSample> {
	const startedAt = Date.now()
	let ttftMs: number | undefined
	let reasoningChars = 0
	let reasoningTokens: number | undefined
	let content = ""

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
				stream_options: { include_usage: true },
				// Enough to see reasoning start; slow models need not finish it.
				max_tokens: 400,
				messages: [{ role: "user", content: THINKING_PROMPT }],
				...patch,
			}),
		})
		if (!response.ok || !response.body) {
			return {
				status: response.status,
				ok: false,
				reasoningChars: 0,
				contentChars: 0,
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
					const reasoning = delta?.reasoning_content ?? delta?.reasoning
					if (typeof reasoning === "string") {
						reasoningChars += reasoning.length
					}
					if (typeof delta?.content === "string" && delta.content) {
						content += delta.content
						ttftMs ??= Date.now() - startedAt
					}
					const tokens = chunk.usage?.completion_tokens_details?.reasoning_tokens
					if (typeof tokens === "number") {
						reasoningTokens = tokens
					}
				} catch {
					// Partial JSON across chunk boundaries is expected; skip it.
				}
			}
		}

		// Models served without a reasoning parser inline their thinking.
		const inline = content.match(/<think>([\s\S]*?)(<\/think>|$)/)
		if (inline) {
			reasoningChars += inline[1].trim().length
		}
		return {
			status: response.status,
			ok: content.length > 0 || reasoningChars > 0,
			reasoningChars,
			...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
			contentChars: content.length,
			ttftMs,
			totalMs: Date.now() - startedAt,
		}
	} catch (error) {
		return {
			status: 0,
			ok: false,
			reasoningChars: 0,
			contentChars: 0,
			error: error instanceof Error ? error.message : String(error),
		}
	} finally {
		clearTimeout(timeout)
	}
}

/**
 * The prompt asks for one amount, so a reply that runs to a paragraph is the
 * model deliberating in its content. Some backends (kimi-k2.6, the qwen3.6
 * 35B, the nemotron ultra, the sia qwen3.5) expose no reasoning channel and
 * think in the visible reply; counting only reasoning deltas marked each of
 * them as a non-reasoner, so the off-switch was never sent to them.
 */
const IN_CONTENT_REASONING_MIN_CHARS = 60

/** A sample reasons when it produced reasoning text, billed reasoning tokens, or a long answer to a one-word question. */
function reasons(sample: ThinkingSample | undefined): boolean {
	return (
		!!sample?.ok &&
		(sample.reasoningChars > 20 || (sample.reasoningTokens ?? 0) > 0 || sample.contentChars > IN_CONTENT_REASONING_MIN_CHARS)
	)
}

/**
 * Probe every variant `RUNS` times and keep, per variant, the most
 * reasoning-heavy sample: a switch only counts as "off" if it silenced
 * reasoning on every run.
 */
async function probeThinking(entry: CatalogEntry): Promise<ThinkingReport> {
	const variants: Record<string, ThinkingSample> = {}
	for (const [name, patch] of Object.entries(THINKING_VARIANTS)) {
		const samples: ThinkingSample[] = []
		for (let run = 0; run < RUNS; run += 1) {
			samples.push(await probeThinkingOnce(entry.id, patch))
		}
		variants[name] =
			samples.find((sample) => !sample.ok) ??
			samples.reduce((most, sample) => (sample.reasoningChars > most.reasoningChars ? sample : most))
	}

	const rejected = Object.entries(variants)
		.filter(([, sample]) => sample.status >= 400 && sample.status < 500)
		.map(([name]) => name)
	const defaultOn = reasons(variants.baseline)
	const silenced = (name: string) => variants[name]?.ok === true && !reasons(variants[name])

	let off: ThinkingOff | undefined
	let on: ThinkingOn | undefined
	if (defaultOn) {
		off = silenced("template-off")
			? "template-kwargs"
			: silenced("effort-none")
				? "reasoning-effort-none"
				: silenced("reasoning-exclude")
					? "reasoning-exclude"
					: undefined
	} else {
		on = reasons(variants["effort-high"])
			? "reasoning-effort"
			: reasons(variants["template-on"])
				? "template-kwargs"
				: undefined
	}

	return {
		id: entry.id,
		variants,
		defaultOn,
		...(off ? { off } : {}),
		...(on ? { on } : {}),
		rejected,
	}
}

function describeThinking(report: ThinkingReport): string {
	if (report.defaultOn) {
		return report.off ? `on by default · off via \`${report.off}\`` : "**always on**"
	}
	return report.on ? `off by default · on via \`${report.on}\`` : "never"
}

function renderThinkingMarkdown(reports: ThinkingReport[]): string {
	const cell = (sample: ThinkingSample | undefined) => {
		if (!sample) {
			return "—"
		}
		if (!sample.ok) {
			return sample.status ? `✗ ${sample.status}` : "✗"
		}
		const tokens = sample.reasoningTokens ? ` (${sample.reasoningTokens} tok)` : ""
		return `${sample.reasoningChars}${tokens}`
	}
	const names = Object.keys(THINKING_VARIANTS)
	const rows = reports
		.map(
			(report) =>
				`| \`${report.id}\` | ${describeThinking(report)} | ${names.map((name) => cell(report.variants[name])).join(" | ")} |`,
		)
		.join("\n")

	return `# Pliny free model thinking probe

Measured against the live gateway on ${new Date().toISOString().slice(0, 10)}, ${RUNS} run(s) per variant.
Regenerate with:

\`\`\`sh
PLINY_API_KEY=... bun apps/vscode/scripts/probe-pliny-free-models.ts --thinking --runs 2
\`\`\`

Each cell is the number of reasoning characters the model produced for a short
trick question (reasoning deltas, or an inline \`<think>\` block), with billed
reasoning tokens in brackets when the gateway reports them. \`✗ 400\` means the
gateway rejected that request field outright.

| Model | Verdict | ${names.join(" | ")} |
| --- | --- | ${names.map(() => "---").join(" | ")} |
${rows}

## How this feeds the router

The verdict is copied into each model's \`thinking\` entry in
\`sdk/packages/llms/src/providers/data/pliny-models.json\`. FreeAuto's \`quick\`
routes then turn reasoning off only on models with a known off-switch, and its
\`think\` routes turn it on only on models with a known on-switch, so an
unsupported field is never sent.
`
}

async function runThinkingProbe(models: CatalogEntry[], repoRoot: string): Promise<void> {
	console.error(`Probing thinking controls on ${models.length} free models (${RUNS} run(s) per variant)...`)
	const reports: ThinkingReport[] = []
	for (const [index, entry] of models.entries()) {
		process.stderr.write(`  [${index + 1}/${models.length}] ${entry.id} ... `)
		const report = await probeThinking(entry)
		reports.push(report)
		const down = !report.variants.baseline?.ok
		console.error(
			down
				? `DOWN (${report.variants.baseline?.status || "?"}: ${report.variants.baseline?.error?.slice(0, 60) ?? ""})`
				: describeThinking(report).replace(/[`*]/g, ""),
		)
	}

	const jsonPath = path.join(repoRoot, "sdk/packages/llms/src/providers/data/pliny-free-auto-thinking-probe.json")
	const mdPath = path.join(repoRoot, "docs/pliny-free-auto-thinking.md")
	await writeFile(
		jsonPath,
		`${JSON.stringify({ probedAt: new Date().toISOString(), baseURL: BASE_URL, runs: RUNS, reports }, null, 2)}\n`,
	)
	await mkdir(path.dirname(mdPath), { recursive: true })
	await writeFile(mdPath, renderThinkingMarkdown(reports))
	console.error(`\nWrote ${jsonPath}`)
	console.error(`Wrote ${mdPath}`)
}

async function main(): Promise<void> {
	if (!API_KEY) {
		console.error("PLINY_API_KEY is not set; cannot probe the gateway.")
		process.exit(1)
	}

	const models = freeModels()
	const repoRoot = path.resolve(import.meta.dir, "../../..")
	if (THINKING) {
		await runThinkingProbe(models, repoRoot)
		return
	}
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
