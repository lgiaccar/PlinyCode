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

import { defaultRules } from "@plinycode/core/pliny-router"
import {
	canonicalPlinyModelId,
	isPlinyRouterModelId,
	isPlinySelfHostedModelId,
	plinyRouterProfileAllowsPaid,
} from "@plinycode/llms"
import * as yaml from "js-yaml"
import { Logger } from "@/shared/services/Logger"
import {
	ROUTER_MODES,
	ROUTER_TIERS,
	type RouterEffort,
	type RouterMode,
	type RouterReasoningEffort,
	type RouterRoute,
	type RouterRules,
	type RouterTier,
} from "./router-types"

export {
	defaultPool,
	defaultRules,
	routableModelIds,
	rulesFilenameForProfile,
	workspaceRulesFilenameForProfile,
} from "@plinycode/core/pliny-router"

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const YAML_FENCE_PATTERN = /```ya?ml\s*\r?\n([\s\S]*?)```/i
const YAML_FENCE_PATTERN_GLOBAL = /```ya?ml\s*\r?\n[\s\S]*?```/gi

/** Extract the first fenced yaml block from a Markdown document. */
export function extractYamlBlock(markdown: string): string | undefined {
	return markdown.match(YAML_FENCE_PATTERN)?.[1]
}

/** Prose outside the yaml fence, used as classifier guidance. HTML comments (the seed marker) are dropped. */
export function extractGuidance(markdown: string): string {
	return markdown
		.replace(YAML_FENCE_PATTERN_GLOBAL, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.trim()
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asPositive(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function asNonNegative(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

/**
 * Whether a rules file may route to this id. Free, self-hosted ids always
 * qualify. Paid ids qualify only for a profile that allows them (BalanceAuto):
 * this is the guard that keeps a hand-edited FreeAuto file from silently
 * sending work to a paid hosted model. A virtual router id never qualifies.
 */
function isRoutableModelId(id: string, allowPaid: boolean): boolean {
	if (isPlinySelfHostedModelId(id)) {
		return true
	}
	return allowPaid && !isPlinyRouterModelId(id)
}

export function sanitizeModelIds(value: unknown, allowPaid: boolean): string[] {
	if (!Array.isArray(value)) {
		return []
	}
	const seen = new Set<string>()
	const ids: string[] = []
	for (const entry of value) {
		const text = asString(entry)
		const id = text ? canonicalPlinyModelId(text) : undefined
		if (!id || seen.has(id) || !isRoutableModelId(id, allowPaid)) {
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
		...(ROUTER_MODES.includes(mode as RouterMode) ? { mode: mode as RouterMode } : {}),
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

function parseRoutes(value: unknown, allowPaid: boolean): RouterRoute[] {
	if (!Array.isArray(value)) {
		return []
	}
	const routes: RouterRoute[] = []
	for (const entry of value) {
		if (!entry || typeof entry !== "object") {
			continue
		}
		const raw = entry as Record<string, unknown>
		const use = sanitizeModelIds(raw.use, allowPaid)
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
	const allowPaid = plinyRouterProfileAllowsPaid(profile)

	const pool = sanitizeModelIds(raw.pool, allowPaid)
	const routes = parseRoutes(raw.routes, allowPaid)
	const utility = (raw.utility ?? {}) as Record<string, unknown>
	const classifier = (raw.classifier ?? {}) as Record<string, unknown>
	const guard = (raw.guard ?? {}) as Record<string, unknown>
	const health = (raw.health ?? {}) as Record<string, unknown>
	const escalation = (raw.escalation ?? {}) as Record<string, unknown>

	const utilityOrDefault = (value: unknown, fallback: string): string => {
		const text = asString(value)
		const id = text ? canonicalPlinyModelId(text) : undefined
		return id && isRoutableModelId(id, allowPaid) ? id : fallback
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
			maxPaidCallsPerTurn: asNonNegative(health.maxPaidCallsPerTurn) ?? defaults.health.maxPaidCallsPerTurn,
			firstTokenTimeoutMs: asPositive(health.firstTokenTimeoutMs) ?? defaults.health.firstTokenTimeoutMs,
			stallTimeoutMs: asPositive(health.stallTimeoutMs) ?? defaults.health.stallTimeoutMs,
		},
		escalation: {
			afterStalls: asPositive(escalation.afterStalls) ?? defaults.escalation.afterStalls,
			afterFailedCommands: asPositive(escalation.afterFailedCommands) ?? defaults.escalation.afterFailedCommands,
			maxNudgesPerRun: asNonNegative(escalation.maxNudgesPerRun) ?? defaults.escalation.maxNudgesPerRun,
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
