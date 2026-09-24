import { estimateTokens } from "@plinycode/shared"
import { ClineRulesToggles } from "@shared/cline-rules"
import fs from "fs/promises"

/**
 * Estimated prompt tokens of one instruction file, using the same
 * characters-per-token heuristic as the SDK's context breakdown so the Rules
 * and Skills panels agree with the context-window numbers shown in chat.
 * Returns 0 when the file cannot be read.
 */
export async function estimateFileTokens(filePath: string): Promise<number> {
	try {
		const content = await fs.readFile(filePath, "utf8")
		return content.trim().length > 0 ? estimateTokens(content.length) : 0
	} catch {
		return 0
	}
}

/** Estimated tokens for every rule file listed in the given toggle maps, keyed by file path. */
export async function estimateRuleFileTokens(toggleMaps: ClineRulesToggles[]): Promise<Record<string, number>> {
	const paths = [...new Set(toggleMaps.flatMap((toggles) => Object.keys(toggles)))]
	const counts = await Promise.all(paths.map(async (filePath) => [filePath, await estimateFileTokens(filePath)] as const))
	return Object.fromEntries(counts)
}
