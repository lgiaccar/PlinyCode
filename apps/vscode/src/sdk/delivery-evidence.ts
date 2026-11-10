import type { DeliveryCategory, DeliveryEvidence, DeliverySnapshot } from "@shared/delivery"

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function category(name: string, input: string): DeliveryCategory | undefined {
	const tool = name.split("__").at(-1) ?? name
	if (["pr_create", "pr_get", "pr_update", "pr_review"].includes(tool)) return "pullRequest"
	if (["pr_checks", "pipeline_runs", "pipeline_report", "watch_ci"].includes(tool)) return "ci"
	if (!["run_commands", "execute_command"].includes(tool)) return undefined
	if (/\b(?:gh\s+release|release:(?:publish|package)|vsce\s+publish)\b/i.test(input)) return "release"
	if (/\bgh\s+pr\s+(?:create|view|merge)\b/i.test(input)) return "pullRequest"
	if (/\bgh\s+(?:pr\s+checks|run\s+(?:view|watch|list))\b/i.test(input)) return "ci"
	if (/\b(?:test(?::[\w-]+)?|pytest|ctest|vitest|check(?::[\w-]+)?|typecheck|lint)\b/i.test(input)) return "checks"
	return undefined
}

/** Only paired engine tool calls/results are evidence. Assistant prose never is. */
export function collectDeliveryEvidence(messages: readonly unknown[]): DeliverySnapshot {
	const calls = new Map<string, { name: string; input: string }>()
	const evidence: DeliveryEvidence[] = []
	for (const raw of messages) {
		const message = record(raw)
		if (!Array.isArray(message?.content)) continue
		for (const rawBlock of message.content) {
			const block = record(rawBlock)
			if (!block) continue
			if (
				message.role === "assistant" &&
				block.type === "tool_use" &&
				typeof block.id === "string" &&
				typeof block.name === "string"
			) {
				calls.set(block.id, { name: block.name, input: JSON.stringify(block.input ?? {}) })
			} else if (message.role === "user" && block.type === "tool_result" && typeof block.tool_use_id === "string") {
				const call = calls.get(block.tool_use_id)
				if (!call) continue
				calls.delete(block.tool_use_id)
				const kind = category(call.name, call.input)
				if (!kind) continue
				const output = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
				evidence.push({
					id: block.tool_use_id,
					category: kind,
					tool: call.name,
					input: call.input.slice(0, 4000),
					output: output.slice(0, 12000),
					failed: block.is_error === true,
					at: typeof message.createdAt === "number" ? message.createdAt : undefined,
					truncated: call.input.length > 4000 || output.length > 12000,
				})
			}
		}
	}
	return { evidence: evidence.slice(-40), omitted: Math.max(0, evidence.length - 40) }
}
