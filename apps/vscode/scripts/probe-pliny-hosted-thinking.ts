#!/usr/bin/env bun
/**
 * Probe: does the Pliny gateway honour `reasoning_effort` on a hosted (paid)
 * model? The answer decides the `thinking` entry of its catalog record, and so
 * whether the model tuning button offers thinking and effort controls for it
 * (docs/model-tuning.md).
 *
 * Sends one short reasoning question per variant (no field, effort low, effort
 * high, effort none) twice, and prints per call the reasoning the reply carried:
 * `reasoning_content` characters and billed reasoning tokens. A switch counts
 * when it moves those numbers the same way on both runs. Each call costs a
 * fraction of a cent.
 *
 * Usage: PLINY_API_KEY=... bun --use-system-ca scripts/probe-pliny-hosted-thinking.ts <model id>...
 */
import catalog from "../../../sdk/packages/llms/src/providers/data/pliny-models.json"

const API_KEY = process.env.PLINY_API_KEY
const RUNS = 2
const PROMPT =
	"What is the smallest positive integer n such that n! ends in at least 20 zeros? Think it through, then reply with just the number."

const VARIANTS: Record<string, Record<string, unknown>> = {
	baseline: {},
	"effort-low": { reasoning_effort: "low" },
	"effort-high": { reasoning_effort: "high" },
	"effort-none": { reasoning_effort: "none" },
}

async function probeOnce(model: string, patch: Record<string, unknown>) {
	const startedAt = Date.now()
	try {
		const response = await fetch(`${catalog.baseURL}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${API_KEY}`,
				...(catalog.headers as Record<string, string>),
			},
			body: JSON.stringify({
				model,
				stream: false,
				max_tokens: 8000,
				messages: [{ role: "user", content: PROMPT }],
				...patch,
			}),
			signal: AbortSignal.timeout(180_000),
		})
		const text = await response.text()
		if (!response.ok) {
			return { status: response.status, ms: Date.now() - startedAt, error: text.slice(0, 160) }
		}
		const body = JSON.parse(text)
		const message = body.choices?.[0]?.message ?? {}
		const reasoning = message.reasoning_content ?? message.reasoning
		return {
			status: response.status,
			ms: Date.now() - startedAt,
			reasoningChars: typeof reasoning === "string" ? reasoning.length : 0,
			reasoningTokens: body.usage?.completion_tokens_details?.reasoning_tokens,
			completionTokens: body.usage?.completion_tokens,
			costUsd: body.usage?.costInUSD,
		}
	} catch (error) {
		return { status: 0, ms: Date.now() - startedAt, error: String(error).slice(0, 160) }
	}
}

async function main(): Promise<void> {
	const models = process.argv.slice(2)
	if (!API_KEY || models.length === 0) {
		console.error("Usage: PLINY_API_KEY=... bun --use-system-ca scripts/probe-pliny-hosted-thinking.ts <model id>...")
		process.exit(1)
	}
	for (const model of models) {
		for (const [variant, patch] of Object.entries(VARIANTS)) {
			for (let run = 0; run < RUNS; run += 1) {
				console.log(JSON.stringify({ model, variant, run, ...(await probeOnce(model, patch)) }))
				// The gateway answers bursts with 429 alluser_limit.
				await Bun.sleep(1500)
			}
		}
	}
}

await main()
