/**
 * Loading and validation of the FreeAuto rules file.
 *
 * The file is Markdown so it can explain itself: prose documents each knob and
 * doubles as guidance for the optional LLM classifier, while a single fenced
 * yaml block carries the machine-readable rules. A global file lives in the
 * PlinyCode data directory; a workspace file may add routes that take
 * precedence. A missing or malformed file is never fatal — the built-in
 * defaults are used and the problem is logged, because a broken rules file must
 * not be able to block a turn.
 */

import { isPlinySelfHostedModelId, plinyFreePoolIds } from "@plinycode/llms"
import * as yaml from "js-yaml"
import { Logger } from "@/shared/services/Logger"
import type { RouterRoute, RouterRules } from "./router-types"

/** Name of the rules file in both the global and workspace locations. */
export const ROUTER_RULES_FILENAME = "pliny-free-auto.md"

const DEFAULT_HEALTH = {
	cooldownMs: 600_000,
	failuresBeforeCooldown: 2,
	maxFailoversPerTurn: 3,
	firstTokenTimeoutMs: 120_000,
	stallTimeoutMs: 90_000,
} as const

const DEFAULT_CLASSIFIER = {
	enabled: false,
	timeoutMs: 8_000,
	maxPromptChars: 4_000,
} as const

/**
 * Background-job models, chosen from the live probe
 * (`scripts/probe-pliny-free-models.ts`, see docs/pliny-free-auto-router.md):
 *
 * - classifier: the fastest responder measured (~284ms to first token). It does
 *   not call tools, which is irrelevant here — classification is a plain
 *   text answer — and it keeps the extra per-turn call cheap.
 * - summarizer: a large-context model, because a compaction summary is by
 *   definition produced from a conversation that no longer fits.
 * - commit: a mid-size model with a good token rate; commit messages are short.
 */
const DEFAULT_UTILITY = {
	classifier: "snps-provider/qwen3-6-35b-a3b-1-28dd3",
	summarizer: "snps-provider/nvidia-nemotron-3-super-120b-a12",
	commit: "snps-provider/qwen3-next-80b-a3b-instruct-d79b4",
} as const

/**
 * Models we want tried first. The rest of the pool follows in catalog order, so
 * a catalog refresh can add models without anyone editing this list, and an id
 * retired from the catalog simply disappears.
 */
const PREFERRED_HEAD = [
	// Ordered from the live probe plus field experience: every model here
	// answered and really called a tool. The coder model leads because most
	// turns are code edits and it has the fastest first token of the large
	// models; nemotron-ultra and kimi-k2.6 are the fastest large-context
	// generalists. GLM-5.2 is last: it is the only 512k option but far slower
	// than everything else, so it is a fallback rather than a first choice.
	"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
	"snps-provider/nemotron-3-ultra-550b-a55",
	"snps-provider/kimi-k2.6",
	"snps-provider/nvidia-nemotron-3-super-120b-a12",
	"snps-provider/qwen3.5-397b-fp8",
	"snps-provider/GLM-5.2",
]

export function defaultPool(): string[] {
	const catalogIds = plinyFreePoolIds()
	const available = new Set(catalogIds)
	const head = PREFERRED_HEAD.filter((id) => available.has(id))
	const tail = catalogIds.filter((id) => !head.includes(id))
	return [...head, ...tail]
}

const DEFAULT_ROUTES: RouterRoute[] = [
	{
		name: "huge-context",
		when: { minEstimatedTokens: 180_000 },
		// Both 512k. The vmodels replica is load-balanced and measured faster
		// than the primary, so it leads; the primary is the backup.
		use: ["snps-provider-vmodels/glm-5.2", "snps-provider/GLM-5.2"],
	},
	{
		name: "subagent",
		// Delegated tasks are short and bounded: favour first-token latency.
		when: { subAgent: true, maxEstimatedTokens: 100_000 },
		use: [
			"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
			"snps-provider/nvidia-nemotron-3-super-120b-a12",
			"snps-provider/kimi-k2.6",
		],
	},
	{
		name: "plan-and-reasoning",
		when: {
			mode: "plan",
			promptRegex: "\\b(plan|design|architect|why|explain|review|compare|investigate|analy[sz]e)\\b",
		},
		use: ["snps-provider/qwen3.5-397b-fp8", "snps-provider/kimi-k2.6", "snps-provider/nemotron-3-ultra-550b-a55"],
	},
	{
		name: "coding",
		when: {
			mode: "act",
			maxEstimatedTokens: 100_000,
			promptRegex:
				"\\b(fix|implement|refactor|add|edit|write|test|bug|error|compile|patch|rename|conflicts?|merge|rebase|lint|failing)\\b|type ?error|\\.(ts|tsx|py|go|rs|java|cs|js)\\b",
		},
		use: [
			"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
			"snps-provider/nemotron-3-ultra-550b-a55",
			"snps-provider/kimi-k2.6",
		],
	},
	{
		name: "quick",
		when: {
			maxPromptChars: 300,
			maxEstimatedTokens: 30_000,
			promptRegex: "^(what|how|where|which|is|does|can|list|show)\\b",
		},
		use: [
			"snps-provider/qwen3-next-80b-a3b-instruct-d79b4",
			"snps-provider/nvidia-nemotron-3-super-120b-a12",
			"snps-provider/kimi-k2.6",
		],
	},
	{
		name: "default",
		use: [
			"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
			"snps-provider/kimi-k2.6",
			"snps-provider/nemotron-3-ultra-550b-a55",
			"snps-provider/nvidia-nemotron-3-super-120b-a12",
		],
	},
]

/** The rules used when no file exists, or when one cannot be parsed. */
export function defaultRules(): RouterRules {
	return {
		version: 1,
		pool: defaultPool(),
		utility: { ...DEFAULT_UTILITY },
		classifier: { ...DEFAULT_CLASSIFIER },
		health: { ...DEFAULT_HEALTH },
		contextMarginRatio: 1.15,
		sticky: true,
		routes: DEFAULT_ROUTES.map((route) => ({ ...route, use: [...route.use] })),
	}
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const YAML_FENCE_PATTERN = /```ya?ml\s*\r?\n([\s\S]*?)```/i
const YAML_FENCE_PATTERN_GLOBAL = /```ya?ml\s*\r?\n[\s\S]*?```/gi

/** Extract the first fenced yaml block from a Markdown document. */
export function extractYamlBlock(markdown: string): string | undefined {
	return markdown.match(YAML_FENCE_PATTERN)?.[1]
}

/** Prose outside the yaml fence, used as classifier guidance. */
export function extractGuidance(markdown: string): string {
	return markdown.replace(YAML_FENCE_PATTERN_GLOBAL, "").trim()
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asPositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

/**
 * Only free, self-hosted ids may be routed to. This is the guard that keeps a
 * hand-edited rules file from silently sending work to a paid hosted model.
 */
function sanitizeModelIds(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return []
	}
	const seen = new Set<string>()
	const ids: string[] = []
	for (const entry of value) {
		const id = asString(entry)
		if (!id || seen.has(id) || !isPlinySelfHostedModelId(id)) {
			continue
		}
		seen.add(id)
		ids.push(id)
	}
	return ids
}

function isValidRegex(pattern: string): boolean {
	try {
		new RegExp(pattern, "i")
		return true
	} catch {
		Logger.warn(`[FreeAuto] Ignoring invalid promptRegex in rules file: ${pattern}`)
		return false
	}
}

function parseCondition(value: unknown): RouterRoute["when"] {
	if (!value || typeof value !== "object") {
		return undefined
	}
	const raw = value as Record<string, unknown>
	const mode = asString(raw.mode)
	const promptRegex = asString(raw.promptRegex)
	const minEstimatedTokens = asPositive(raw.minEstimatedTokens)
	const maxEstimatedTokens = asPositive(raw.maxEstimatedTokens)
	const maxPromptChars = asPositive(raw.maxPromptChars)
	const subAgent = typeof raw.subAgent === "boolean" ? raw.subAgent : undefined
	return {
		...(mode === "plan" || mode === "act" ? { mode } : {}),
		...(minEstimatedTokens !== undefined ? { minEstimatedTokens } : {}),
		...(maxEstimatedTokens !== undefined ? { maxEstimatedTokens } : {}),
		...(maxPromptChars !== undefined ? { maxPromptChars } : {}),
		...(promptRegex && isValidRegex(promptRegex) ? { promptRegex } : {}),
		...(subAgent !== undefined ? { subAgent } : {}),
	}
}

function parseRoutes(value: unknown): RouterRoute[] {
	if (!Array.isArray(value)) {
		return []
	}
	const routes: RouterRoute[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue
		}
		const raw = entry as Record<string, unknown>
		const use = sanitizeModelIds(raw.use)
		if (use.length === 0) {
			continue
		}
		routes.push({
			name: asString(raw.name) ?? `route-${routes.length + 1}`,
			when: parseCondition(raw.when),
			use,
		})
	}
	return routes
}

/**
 * Turn a parsed YAML document into `RouterRules`, filling anything missing or
 * invalid from the defaults. Never throws.
 */
export function normalizeRules(document: unknown, guidance?: string): RouterRules {
	const defaults = defaultRules()
	if (!document || typeof document !== "object") {
		return { ...defaults, ...(guidance ? { guidance } : {}) }
	}
	const raw = document as Record<string, unknown>

	const pool = sanitizeModelIds(raw.pool)
	const routes = parseRoutes(raw.routes)
	const utility = (raw.utility ?? {}) as Record<string, unknown>
	const classifier = (raw.classifier ?? {}) as Record<string, unknown>
	const health = (raw.health ?? {}) as Record<string, unknown>

	const utilityOrDefault = (value: unknown, fallback: string): string => {
		const id = asString(value)
		return id && isPlinySelfHostedModelId(id) ? id : fallback
	}

	return {
		version: asPositive(raw.version) ?? defaults.version,
		pool: pool.length > 0 ? pool : defaults.pool,
		utility: {
			classifier: utilityOrDefault(utility.classifier, defaults.utility.classifier),
			summarizer: utilityOrDefault(utility.summarizer, defaults.utility.summarizer),
			commit: utilityOrDefault(utility.commit, defaults.utility.commit),
		},
		classifier: {
			enabled: classifier.enabled === true,
			timeoutMs: asPositive(classifier.timeoutMs) ?? defaults.classifier.timeoutMs,
			maxPromptChars: asPositive(classifier.maxPromptChars) ?? defaults.classifier.maxPromptChars,
		},
		health: {
			cooldownMs: asPositive(health.cooldownMs) ?? defaults.health.cooldownMs,
			failuresBeforeCooldown: asPositive(health.failuresBeforeCooldown) ?? defaults.health.failuresBeforeCooldown,
			maxFailoversPerTurn: asPositive(health.maxFailoversPerTurn) ?? defaults.health.maxFailoversPerTurn,
			firstTokenTimeoutMs: asPositive(health.firstTokenTimeoutMs) ?? defaults.health.firstTokenTimeoutMs,
			stallTimeoutMs: asPositive(health.stallTimeoutMs) ?? defaults.health.stallTimeoutMs,
		},
		contextMarginRatio: asPositive(raw.contextMarginRatio) ?? defaults.contextMarginRatio,
		sticky: raw.sticky === undefined ? defaults.sticky : raw.sticky === true,
		routes: routes.length > 0 ? routes : defaults.routes,
		...(guidance ? { guidance } : {}),
	}
}

/** Parse a rules file's Markdown into rules. Never throws. */
export function parseRulesMarkdown(markdown: string): RouterRules {
	const guidance = extractGuidance(markdown)
	const block = extractYamlBlock(markdown)
	if (!block) {
		Logger.warn("[FreeAuto] Rules file has no yaml block; using built-in defaults")
		return { ...defaultRules(), ...(guidance ? { guidance } : {}) }
	}
	try {
		return normalizeRules(yaml.load(block, { schema: yaml.JSON_SCHEMA }), guidance)
	} catch (error) {
		Logger.warn(`[FreeAuto] Rules file YAML is invalid; using built-in defaults: ${error}`)
		return { ...defaultRules(), ...(guidance ? { guidance } : {}) }
	}
}

/**
 * Merge a workspace file over the global one. Workspace routes are evaluated
 * first (so a project can special-case without restating everything) and any
 * scalar the workspace sets wins.
 */
export function mergeRules(global: RouterRules, workspace: RouterRules | undefined): RouterRules {
	if (!workspace) {
		return global
	}
	const seen = new Set<string>()
	const routes = [...workspace.routes, ...global.routes].filter((route) => {
		const key = `${route.name}:${route.use.join(",")}`
		if (seen.has(key)) {
			return false
		}
		seen.add(key)
		return true
	})
	const guidance = [global.guidance, workspace.guidance].filter(Boolean).join("\n\n")
	return {
		...global,
		...workspace,
		routes,
		...(guidance ? { guidance } : { guidance: undefined }),
	}
}
