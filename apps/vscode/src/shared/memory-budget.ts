import { compactionSizeTokens, type RouterCompactionSize } from "./router-tuning"

export function parseMemoryBudget(value: string | number): RouterCompactionSize | "auto" | undefined {
	if (String(value).trim().toLowerCase() === "auto") return "auto"
	const match = String(value)
		.trim()
		.match(/^(\d+(?:\.\d+)?)\s*(%)?$/)
	if (!match) return undefined
	const amount = Number(match[1])
	if (match[2] ? amount > 100 : !Number.isInteger(amount) || amount > 64_000) return undefined
	return { unit: match[2] ? "percent" : "tokens", value: amount }
}

export function memoryBudgetTokens(value: string | number, contextWindow: number): number {
	const parsed = parseMemoryBudget(value)
	const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 32_000
	return parsed === "auto" ? Math.min(4000, Math.floor(window * 0.04)) : Math.max(0, compactionSizeTokens(parsed, window) ?? 0)
}
