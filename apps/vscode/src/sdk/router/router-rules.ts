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
import {
	ROUTER_TIERS,
	type RouterEffort,
	type RouterReasoningEffort,
	type RouterRoute,
	type RouterRules,
	type RouterTier,
} from "./router-types"

/** Name of the default profile's rules file in both the global and workspace locations. */
export const ROUTER_RULES_FILENAME = "pliny-free-auto.md"

/** Rules file name for a profile: `pliny-free-auto.md`, `pliny-free-auto.fast.md`, ... */
export function rulesFilenameForProfile(profile: string): string {
	return profile === "default" ? ROUTER_RULES_FILENAME : `pliny-free-auto.${profile}.md`
}

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
 * The completion guard's pattern rules are always on; the judge — one extra
 * small-model call when an agentic run is about to end — is on by default
 * because a missed early stop costs far more than the call.
 */
const DEFAULT_GUARD = {
	judge: true,
	judgeTimeoutMs: 6_000,
} as const

/**
 * Background-job models, chosen from the live probe
 * (`scripts/probe-pliny-free-models.ts`, see docs/pliny-free-auto-router.md):
 *
 * - classifier: the fastest responder measured (~284ms to first token). It does
 *   not call tools, which is irrelevant here — classification is a plain
 *   text answer — and it keeps the extra per-turn call cheap.
 * - judge: the same model, asked once per run whether the task is done.
 * - summarizer: a large-context model, because a compaction summary is by
 *   definition produced from a conversation that no longer fits.
 * - commit: a mid-size model with a good token rate; commit messages are short.
 */
const DEFAULT_UTILITY = {
	classifier: "snps-provider/qwen3-6-35b-a3b-1-28dd3",
	judge: "snps-provider/qwen3-6-35b-a3b-1-28dd3",
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
	// answered and really called a tool. kimi-k2.6 leads: a 256k window, the
	// best throughput, and it keeps calling tools through long multi-step
	// tasks. The coder model is quick at targeted edits but tends to announce
	// a step and stop on long tasks, so it leads only the coding route.
	// GLM-5.2 is last: the only 512k option, but far slower than the rest.
	"snps-provider/kimi-k2.6",
	"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
	"snps-provider/nemotron-3-ultra-550b-a55",
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

/**
 * Effort follows the thinking probe: reasoning is switched off for everyday
 * work (it multiplies latency on the models that do it by default, GLM-5.2
 * above all) and on for planning. It only applies to models whose switch was
 * measured; every other model keeps its default.
 */
const DEFAULT_ROUTES: RouterRoute[] = [
	{
		name: "huge-context",
		tier: "huge",
		when: { minEstimatedTokens: 180_000 },
		// Both 512k. The vmodels replica is load-balanced and measured faster
		// than the primary, so it leads; the primary is the backup. Reasoning
		// off: at this size GLM's default thinking dominates the wait.
		use: ["snps-provider-vmodels/glm-5.2", "snps-provider/GLM-5.2"],
		effort: "quick",
	},
	{
		name: "subagent",
		// Delegated tasks are bounded but multi-step (explore, then report), and
		// a sub-agent that stops early hands the parent a half result.
		when: { subAgent: true, maxEstimatedTokens: 100_000 },
		use: [
			"snps-provider/kimi-k2.6",
			"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
			"snps-provider/nvidia-nemotron-3-super-120b-a12",
		],
		effort: "quick",
	},
	{
		name: "plan-and-reasoning",
		tier: "reason",
		when: {
			mode: "plan",
			promptRegex: "\\b(plan|design|architect|why|explain|review|compare|investigate|analy[sz]e)\\b",
		},
		use: ["snps-provider/qwen3.5-397b-fp8", "snps-provider/kimi-k2.6", "snps-provider/nemotron-3-ultra-550b-a55"],
		effort: "think",
		reasoningEffort: "high",
	},
	{
		name: "coding",
		tier: "code",
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
		effort: "quick",
	},
	{
		name: "quick",
		tier: "quick",
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
		effort: "quick",
	},
	{
		name: "default",
		// The catch-all gets the long multi-step tasks, so it leads with the
		// model that keeps acting rather than the fastest editor.
		use: [
			"snps-provider/kimi-k2.6",
			"snps-provider/qwen3-coder-480b-a35b-inst-fp8",
			"snps-provider/nemotron-3-ultra-550b-a55",
			"snps-provider/nvidia-nemotron-3-super-120b-a12",
		],
	},
]

/**
 * Built-in rules for a FreeAuto profile, used when its file does not exist or
 * cannot be parsed, and to seed the file on first activation.
 *
 * - default: heuristic routes, reasoning per route, no classifier.
 * - fast: the same routes with reasoning off everywhere it can be switched off.
 * - smart: the default routes plus the classifier, which picks the tier and
 *   whether to think once per turn.
 */
export function defaultRules(profile = "default"): RouterRules {
	const routes = DEFAULT_ROUTES.map((route) => ({ ...route, use: [...route.use] }))
	if (profile === "fast") {
		for (const route of routes) {
			route.effort = "quick"
			delete route.reasoningEffort
		}
	}
	return {
		version: 1,
		pool: defaultPool(),
		utility: { ...DEFAULT_UTILITY },
		classifier: { ...DEFAULT_CLASSIFIER, enabled: profile === "smart" },
		guard: { ...DEFAULT_GUARD },
		health: { ...DEFAULT_HEALTH },
		contextMarginRatio: 1.15,
		sticky: true,
		routes,
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
	const text = asString(value)?.toLowerCase()
	return text && (allowed as readonly string[]).includes(text) ? (text as T) : undefined
}

const EFFORTS: readonly RouterEffort[] = ["quick", "think"]
const REASONING_EFFORTS: readonly RouterReasoningEffort[] = ["low", "medium", "high"]

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
		const tier = oneOf<RouterTier>(raw.tier, ROUTER_TIERS)
		const effort = oneOf(raw.effort, EFFORTS)
		const reasoningEffort = oneOf(raw.reasoningEffort, REASONING_EFFORTS)
		routes.push({
			name: asString(raw.name) ?? `route-${routes.length + 1}`,
			...(tier ? { tier } : {}),
			when: parseCondition(raw.when),
			use,
			...(effort ? { effort } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
		})
	}
	return routes
}

/**
 * Turn a parsed YAML document into `RouterRules`, filling anything missing or
 * invalid from the profile's defaults. Never throws.
 */
export function normalizeRules(document: unknown, guidance?: string, profile = "default"): RouterRules {
	const defaults = defaultRules(profile)
	if (!document || typeof document !== "object") {
		return { ...defaults, ...(guidance ? { guidance } : {}) }
	}
	const raw = document as Record<string, unknown>

	const pool = sanitizeModelIds(raw.pool)
	const routes = parseRoutes(raw.routes)
	const utility = (raw.utility ?? {}) as Record<string, unknown>
	const classifier = (raw.classifier ?? {}) as Record<string, unknown>
	const guard = (raw.guard ?? {}) as Record<string, unknown>
	const health = (raw.health ?? {}) as Record<string, unknown>

	const utilityOrDefault = (value: unknown, fallback: string): string => {
		const id = asString(value)
		return id && isPlinySelfHostedModelId(id) ? id : fallback
	}

	const classifierModel = utilityOrDefault(utility.classifier, defaults.utility.classifier)
	return {
		version: asPositive(raw.version) ?? defaults.version,
		pool: pool.length > 0 ? pool : defaults.pool,
		utility: {
			classifier: classifierModel,
			// An unset judge follows the classifier, so one edit moves both.
			judge: utilityOrDefault(utility.judge, utility.judge === undefined ? classifierModel : defaults.utility.judge),
			summarizer: utilityOrDefault(utility.summarizer, defaults.utility.summarizer),
			commit: utilityOrDefault(utility.commit, defaults.utility.commit),
		},
		classifier: {
			enabled: typeof classifier.enabled === "boolean" ? classifier.enabled : defaults.classifier.enabled,
			timeoutMs: asPositive(classifier.timeoutMs) ?? defaults.classifier.timeoutMs,
			maxPromptChars: asPositive(classifier.maxPromptChars) ?? defaults.classifier.maxPromptChars,
		},
		guard: {
			judge: typeof guard.judge === "boolean" ? guard.judge : defaults.guard.judge,
			judgeTimeoutMs: asPositive(guard.judgeTimeoutMs) ?? defaults.guard.judgeTimeoutMs,
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
export function parseRulesMarkdown(markdown: string, profile = "default"): RouterRules {
	const guidance = extractGuidance(markdown)
	const block = extractYamlBlock(markdown)
	if (!block) {
		Logger.warn("[FreeAuto] Rules file has no yaml block; using built-in defaults")
		return { ...defaultRules(profile), ...(guidance ? { guidance } : {}) }
	}
	try {
		return normalizeRules(yaml.load(block, { schema: yaml.JSON_SCHEMA }), guidance, profile)
	} catch (error) {
		Logger.warn(`[FreeAuto] Rules file YAML is invalid; using built-in defaults: ${error}`)
		return { ...defaultRules(profile), ...(guidance ? { guidance } : {}) }
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
