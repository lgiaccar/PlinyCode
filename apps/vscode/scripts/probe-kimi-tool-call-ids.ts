#!/usr/bin/env bun
/**
 * A/B probe: does the shape of the tool-call ids in the history change how
 * Kimi K2.6 writes its next tool call?
 *
 * Replays one fixed agent history (6 earlier tool calls, the next step is
 * obviously another call) with three id styles and counts what comes back.
 *
 * Usage: PLINY_API_KEY=... bun --use-system-ca scripts/probe-kimi-tool-call-ids.ts [--runs 12] [--model snps-provider/kimi-k2.6]
 */
import catalog from "../../../sdk/packages/llms/src/providers/data/pliny-models.json"
import { toSafeToolCallId } from "../../../sdk/packages/llms/src/providers/routing/tool-call-ids"

const arg = (name: string) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined)
const RUNS = Number(arg("--runs")) || 12
const MODEL = arg("--model") ?? "snps-provider/kimi-k2.6"
const BASE_URL = process.env.PLINY_BASE_URL ?? catalog.baseURL
const API_KEY = process.env.PLINY_API_KEY

const tools = [
	{
		type: "function",
		function: {
			name: "read_files",
			description: "Read the full content of text files at the given absolute paths.",
			parameters: {
				type: "object",
				properties: {
					files: {
						type: "array",
						items: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				},
				required: ["files"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "run_commands",
			description: "Run shell commands in the workspace.",
			parameters: {
				type: "object",
				properties: { commands: { type: "array", items: { type: "string" } } },
				required: ["commands"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "search_codebase",
			description: "Search the codebase with regular expressions.",
			parameters: {
				type: "object",
				properties: { queries: { type: "array", items: { type: "string" } } },
				required: ["queries"],
			},
		},
	},
]

/** Earlier steps of the task: [tool, arguments, result]. */
const STEPS: Array<[string, unknown, string]> = [
	["run_commands", { commands: ["dir /b scripts"] }, "conan\nrepo\nbenchmarking\ngpu_surfer_make.bat"],
	[
		"search_codebase",
		{ queries: ["ARTIFACTORY_TOKEN"] },
		'scripts/conan/Conan_Installation.bat:14: set ARTIFACTORY_TOKEN=%2\nscripts/repo/setup_lfs_credentials.bat:9: if "%ARTIFACTORY_TOKEN%"=="" goto :usage',
	],
	[
		"read_files",
		{ files: [{ path: "d:\\repo\\scripts\\gpu_surfer_make.bat" }] },
		"@echo off\ncall .\\scripts\\conan\\Conan_Installation.bat %1 %2\ncall .\\scripts\\repo\\setup_lfs_credentials.bat %1 %2",
	],
	[
		"run_commands",
		{ commands: ["dir /b scripts\\conan"] },
		"Conan_Installation.bat\nConan_Installation.sh\nConan_Add_Staging.bat",
	],
	["run_commands", { commands: ["dir /b scripts\\repo"] }, "setup_lfs_credentials.bat\nsetup_lfs_credentials.sh"],
	[
		"search_codebase",
		{ queries: ["conan remote login"] },
		"scripts/conan/Conan_Installation.bat:31: conan remote login artifactory %1 -p %2",
	],
]

const OPAQUE = [
	"call_Zk3h1xQp",
	"chatcmpl-tool-916f85da7b18bc65",
	"toolu_01AbCdEfGh",
	"call_m8xz7x6a",
	"chatcmpl-tool-8370cdd5da8cb917",
	"tool_V1StGXR8_Z5jd",
]

const STYLES: Record<string, (tool: string, index: number) => string> = {
	// What PlinyCode sent up to 0.1.7-test.9: Kimi's own ids, rewritten for Bedrock.
	sanitized: (tool, index) => toSafeToolCallId(`functions.${tool}:${index}`),
	// What it sends now.
	canonical: (tool, index) => `functions.${tool}:${index}`,
	// A history that other models wrote.
	opaque: (_tool, index) => toSafeToolCallId(OPAQUE[index] ?? `call_${index}`),
}

function history(style: (tool: string, index: number) => string) {
	const messages: unknown[] = [
		{
			role: "system",
			content:
				"You are a coding agent. Use the tools to do what the user asks; do not describe a step without calling its tool.",
		},
		{
			role: "user",
			content:
				"Where is the Artifactory token saved and how do I refresh it? Read scripts\\conan\\Conan_Installation.bat and scripts\\repo\\setup_lfs_credentials.bat before answering.",
		},
	]
	STEPS.forEach(([tool, args, result], index) => {
		const id = style(tool, index)
		messages.push({
			role: "assistant",
			content: "",
			tool_calls: [{ id, type: "function", function: { name: tool, arguments: JSON.stringify(args) } }],
		})
		messages.push({ role: "tool", tool_call_id: id, content: result })
	})
	return messages
}

type Outcome = "good call" | "mangled call" | "leaked into text" | "no call"

async function once(style: string): Promise<{ outcome: Outcome; detail: string }> {
	const response = await fetch(`${BASE_URL}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			Authorization: `Bearer ${API_KEY}`,
			...(catalog.headers as Record<string, string>),
		},
		body: JSON.stringify({ model: MODEL, messages: history(STYLES[style]!), tools, max_tokens: 2500 }),
	})
	if (!response.ok) {
		throw new Error(`${response.status} ${(await response.text()).slice(0, 200)}`)
	}
	const body = (await response.json()) as {
		choices: Array<{
			finish_reason: string
			message: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }
		}>
	}
	const message = body.choices[0]?.message
	const call = message?.tool_calls?.[0]
	const content = message?.content ?? ""
	if (call) {
		let argsOk = false
		try {
			argsOk = Object.keys(JSON.parse(call.function.arguments || "{}")).length > 0
		} catch {}
		const known = tools.some((tool) => tool.function.name === call.function.name)
		return {
			outcome: known && argsOk ? "good call" : "mangled call",
			detail: `id=${call.id} name=${JSON.stringify(call.function.name.slice(0, 70))}`,
		}
	}
	if (content.includes("<|tool_call")) {
		return {
			outcome: "leaked into text",
			detail: content.slice(content.indexOf("<|tool_call"), content.indexOf("<|tool_call") + 110),
		}
	}
	return { outcome: "no call", detail: `finish=${body.choices[0]?.finish_reason} …${content.trim().slice(-90)}` }
}

if (!API_KEY) {
	console.error("PLINY_API_KEY is not set")
	process.exit(1)
}
console.log(`model ${MODEL}, ${RUNS} runs per id style\n`)
for (const style of Object.keys(STYLES)) {
	const counts: Record<string, number> = {}
	const details: string[] = []
	// Three at a time: the gateway rate-limits a burst.
	const results: PromiseSettledResult<{ outcome: Outcome; detail: string }>[] = []
	for (let done = 0; done < RUNS; done += 3) {
		results.push(...(await Promise.allSettled(Array.from({ length: Math.min(3, RUNS - done) }, () => once(style)))))
		await new Promise((resolve) => setTimeout(resolve, 5000))
	}
	for (const result of results) {
		if (result.status === "rejected") {
			counts.error = (counts.error ?? 0) + 1
			details.push(`error: ${String(result.reason).slice(0, 120)}`)
			continue
		}
		counts[result.value.outcome] = (counts[result.value.outcome] ?? 0) + 1
		if (result.value.outcome !== "good call" || details.length < 2) {
			details.push(`${result.value.outcome}: ${result.value.detail}`)
		}
	}
	console.log(`## ${style}  (first id: ${STYLES[style]!("run_commands", 0)})`)
	console.log(
		Object.entries(counts)
			.map(([key, value]) => `  ${key}: ${value}/${RUNS}`)
			.join("\n"),
	)
	for (const detail of details.slice(0, 6)) {
		console.log(`    - ${detail.replace(/\s+/g, " ")}`)
	}
	console.log()
}
