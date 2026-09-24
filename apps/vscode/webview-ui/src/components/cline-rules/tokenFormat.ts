/** Compact token count for the Rules/Skills panels, e.g. `850`, `1.2k`, `14k`. */
export function formatTokenCount(tokens: number): string {
	if (tokens < 1000) {
		return String(tokens)
	}
	const thousands = tokens / 1000
	return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`
}

/** Same heuristic as `CHARS_PER_TOKEN` in `@plinycode/shared`, which the extension uses for file counts. */
const CHARS_PER_TOKEN = 3

/**
 * Tokens a skill costs before it is used: its name and description are listed
 * to the model in every request; the full SKILL.md loads only on use.
 */
export function estimateSkillListingTokens(skill: { name: string; description: string }): number {
	return Math.ceil((skill.name.length + skill.description.length + 4) / CHARS_PER_TOKEN)
}

/** Sum the token counts of the enabled entries of a `[path, enabled][]` list. */
export function sumEnabledTokens(rules: [string, boolean][], tokenCounts: Record<string, number>): number {
	return rules.reduce((total, [rulePath, enabled]) => total + (enabled ? (tokenCounts[rulePath] ?? 0) : 0), 0)
}
