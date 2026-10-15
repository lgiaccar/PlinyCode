#!/usr/bin/env bun
/**
 * Probe: does a Pliny Claude model read the conversation back from the prompt
 * cache from one agent step to the next when its turns hold only tool calls?
 *
 * Replays a growing agent history (a fixed system prompt, one user prompt, then
 * N steps of a tool-only assistant turn plus a large tool result) and sends it
 * once per step, the way the agent loop does. Each body goes through
 * `withContentBlockCacheBreakpoints`, the same transform the extension applies,
 * and the script prints what the gateway reports for each call. A nonce in the
 * system prompt keeps every run on a cold cache.
 *
 * `--legacy` places the breakpoints the way the extension did before the fix
 * (system prompt plus the newest user/assistant text), for comparison.
 *
 * Usage: PLINY_API_KEY=... bun --use-system-ca scripts/probe-pliny-prompt-cache.ts
 *          [--model snps-aws-bedrock/global.anthropic.claude-sonnet-5] [--steps 4] [--legacy]
 */
import catalog from "../../../sdk/packages/llms/src/providers/data/pliny-models.json"
import { withContentBlockCacheBreakpoints } from "../../../sdk/packages/llms/src/providers/routing/anthropic-compatible"

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const MODEL = arg("--model") ?? "snps-aws-bedrock/global.anthropic.claude-sonnet-5"
const STEPS = Number(arg("--steps")) || 4
const LEGACY = process.argv.includes("--legacy")
const BASE_URL = process.env.PLINY_BASE_URL ?? catalog.baseURL
const API_KEY = process.env.PLINY_API_KEY

const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`
const filler = (label: string, lines: number) =>
	Array.from(
		{ length: lines },
		(_, i) => `${label} line ${i}: the quick brown fox jumps over the lazy dog while the compiler checks every type.`,
	).join("\n")

const tools = [
	{
		type: "function",
		function: {
			name: "read_files",
			description: "Read the full content of text files at the given absolute paths.",
			parameters: {
				type: "object",
				properties: { paths: { type: "array", items: { type: "string" } } },
				required: ["paths"],
			},
		},
	},
]

type WireMessage = Record<string, unknown>

function history(steps: number): WireMessage[] {
	const messages: WireMessage[] = [
		{ role: "system", content: `Run ${nonce}. You are a coding agent.\n${filler("rules", 120)}` },
		{ role: "user", content: "Read the files one by one, then summarise them." },
	]
	for (let step = 0; step < steps; step++) {
		const id = `call_${step}`
		messages.push({
			role: "assistant",
			content: null,
			tool_calls: [
				{
					id,
					type: "function",
					function: { name: "read_files", arguments: JSON.stringify({ paths: [`/src/f${step}.ts`] }) },
				},
			],
		})
		messages.push({ role: "tool", tool_call_id: id, content: filler(`file ${step}`, 60) })
	}
	return messages
}

function legacyBreakpoints(body: Record<string, unknown>): Record<string, unknown> {
	// The pre-fix transform: system breakpoint plus the newest user/assistant message that already has text.
	const { cache_control: marker, ...rest } = body
	const messages = (rest.messages as WireMessage[]).map((m) => ({ ...m }))
	const mark = (m: WireMessage) =>
		typeof m.content === "string" && m.content.trim()
			? { ...m, content: [{ type: "text", text: m.content, cache_control: marker }] }
			: undefined
	messages[0] = mark(messages[0]) ?? messages[0]
	for (let i = messages.length - 1; i > 0; i--) {
		if (messages[i].role !== "user" && messages[i].role !== "assistant") continue
		const marked = mark(messages[i])
		if (marked) {
			messages[i] = marked
			break
		}
	}
	return { ...rest, messages }
}

async function send(steps: number) {
	const raw = { model: MODEL, max_tokens: 16, messages: history(steps), tools, cache_control: { type: "ephemeral" } }
	const body = LEGACY ? legacyBreakpoints(raw) : withContentBlockCacheBreakpoints(raw)
	const res = await fetch(`${BASE_URL.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
		body: JSON.stringify(body),
	})
	const json = (await res.json()) as { usage?: Record<string, unknown>; error?: unknown }
	if (!res.ok) {
		throw new Error(`HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`)
	}
	return json.usage ?? {}
}

if (!API_KEY) {
	console.error("PLINY_API_KEY is not set")
	process.exit(1)
}
console.log(`model ${MODEL} · ${LEGACY ? "legacy (no text on tool-only turns)" : "fixed"} · run ${nonce}`)
for (let steps = 1; steps <= STEPS; steps++) {
	const usage = await send(steps)
	const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>
	console.log(
		`step ${steps}: prompt ${usage.prompt_tokens} · cached ${details.cached_tokens ?? 0} · cache_read ${usage.cache_read_input_tokens ?? "-"} · cache_write ${usage.cache_creation_input_tokens ?? details.cache_creation_tokens ?? "-"}`,
	)
	console.log(`         raw ${JSON.stringify(usage)}`)
	await new Promise((r) => setTimeout(r, 1500))
}
