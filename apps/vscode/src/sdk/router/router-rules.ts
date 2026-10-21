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

import {
	isPlinyRouterModelId,
	isPlinySelfHostedModelId,
	plinyFreePoolIds,
	plinyHostedPoolIds,
	plinyRouterProfileAllowsPaid,
	plinyRouterProfileSpec,
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

/** Name of the FreeAuto default profile's rules file in both the global and workspace locations. */
const ROUTER_RULES_FILENAME = "pliny-free-auto.md"

/** Name of BalanceAuto's rules file in both the global and workspace locations. */
const BALANCE_RULES_FILENAME = "pliny-balance-auto.md"

/** True for the BalanceAuto family, whose rules may name paid models. */
function isBalanceProfile(profile: string): boolean {
	return plinyRouterProfileSpec(profile)?.family === "balance"
}

/**
 * Global rules file name for a profile: `pliny-free-auto.md`,
 * `pliny-free-auto.fast.md`, ..., and `pliny-balance-auto.md` for BalanceAuto.
 */
export function rulesFilenameForProfile(profile: string): string {
	if (isBalanceProfile(profile)) {
		return BALANCE_RULES_FILENAME
	}
	return profile === "default" ? ROUTER_RULES_FILENAME : `pliny-free-auto.${profile}.md`
}

/**
 * Workspace rules file name for a profile. One file per family: every FreeAuto
 * profile shares `pliny-free-auto.md`, BalanceAuto has `pliny-balance-auto.md`,
 * so a project's free-only overrides never displace BalanceAuto's paid routes.
 */
export function workspaceRulesFilenameForProfile(profile: string): string {
	return isBalanceProfile(profile) ? BALANCE_RULES_FILENAME : ROUTER_RULES_FILENAME
}

const DEFAULT_HEALTH = {
	cooldownMs: 600_000,
	failuresBeforeCooldown: 2,
	maxFailoversPerTurn: 3,
	// A turn that starts on paid Claude stays there (sticky): one turn spent
	// 124 calls on the Sonnet thinking preset polling a build log. Past the cap
	// the rest of the turn runs on the coding route's free lead.
	maxPaidCallsPerTurn: 20,
	firstTokenTimeoutMs: 120_000,
	stallTimeoutMs: 90_000,
} as const

/**
 * The completion guard's escalation: three stalls or six failed commands in a
 * run move the turn to a stronger model, and a run gets at most eight
 * reminders in all (three of them may go unanswered).
 */
const DEFAULT_ESCALATION = {
	afterStalls: 3,
	afterFailedCommands: 6,
	maxNudgesPerRun: 8,
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

// Free self-hosted models the routes name. Ids the catalog no longer lists are
// dropped from the pool by `defaultPool`, and a route's `use` list is filtered
// against the pool at selection time, so a retired id is harmless here.
const KIMI = "snps-provider/kimi-k2.6"
const CODER = "snps-provider/qwen3-coder-480b-a35b-inst-fp8"
const NEMOTRON_ULTRA = "snps-provider/nemotron-3-ultra-550b-a55"
const NEMOTRON_SUPER = "snps-provider/nvidia-nemotron-3-super-120b-a12"
const QWEN_397 = "snps-provider/qwen3.5-397b-fp8"
const QWEN_NEXT = "snps-provider/qwen3-next-80b-a3b-instruct-d79b4"
const GLM = "snps-provider/GLM-5.2"
const GLM_VMODELS = "snps-provider-vmodels/glm-5.2"
const GLM_INTERNAL = "snps-provider-internal-tests/glm-5-2"

/**
 * Each profile's model order: the list of its main routes (default, coding,
 * plan and ask reasoning) and the head of its pool. These are the orders the
 * routers were tuned to in Settings → Router during the 0.2.4 field runs:
 *
 * - default: kimi-k2.6 leads (256k, the best throughput and the strongest
 *   agentic coder in the free pool; its habit of ending a reply on an
 *   announced step is what the completion guard exists for). The GLM-5.2
 *   replicas (512k) follow, so a request too large for kimi lands on GLM
 *   rather than on a smaller model, and the nemotrons are the last resort.
 *   The 128k coder is out: it stops fitting long before compaction.
 * - smart: GLM-5.2 leads, for the strongest reasoning and the 512k window.
 * - fast: the 397B Qwen leads, the coder is the last resort.
 * - balance: Claude Sonnet 4.6 (1M) leads every main route, Sonnet 5 is the
 *   paid backup and kimi the free one.
 */
const DEFAULT_MODELS = [KIMI, GLM_INTERNAL, GLM_VMODELS, NEMOTRON_ULTRA, NEMOTRON_SUPER]
const SMART_MODELS = [GLM, GLM_INTERNAL, KIMI, NEMOTRON_ULTRA, NEMOTRON_SUPER]
const FAST_MODELS = [QWEN_397, NEMOTRON_ULTRA, KIMI, CODER]

/**
 * Models tried after a profile's own order. The rest of the pool follows in
 * catalog order, so a catalog refresh can add models without anyone editing
 * this list, and an id retired from the catalog simply disappears. Every model
 * here answered the live probe and really called a tool.
 */
const PREFERRED_HEAD = [KIMI, GLM_VMODELS, GLM_INTERNAL, GLM, NEMOTRON_ULTRA, NEMOTRON_SUPER, QWEN_397, CODER]

/** The fast profile's head after its model order: the Qwen family first, as latency matters most. */
const FAST_PREFERRED_HEAD = [QWEN_397, CODER, QWEN_NEXT, NEMOTRON_SUPER, NEMOTRON_ULTRA, KIMI, GLM]

// Paid hosted models BalanceAuto routes to. Only ids the catalog verified to
// call tools; the pool filter below drops any that a catalog refresh retires.
const SONNET_5 = "snps-aws-bedrock/global.anthropic.claude-sonnet-5"
const SONNET_46 = "snps-aws-bedrock/aws-claude-sonnet-4.6"
// A preset with thinking baked in: hosted models have no measured reasoning
// switch, so the router cannot turn thinking on for them per call.
const SONNET_46_THINKING = "aws-bedrock-vmodels/claude-4-6-sonnet-high-thinking"
const HAIKU_45 = "snps-aws-bedrock/global-anthropic-claude-haiku-4-5-20251001-v1-0"
const GPT_52 = "azure-openai/gpt-5.2"

/**
 * Paid models BalanceAuto may use, best first. They head its pool so that a
 * turn whose free candidates all fail still lands on a strong model.
 */
const BALANCE_PAID_HEAD = [SONNET_46, SONNET_5, SONNET_46_THINKING, GPT_52, HAIKU_45]

/** BalanceAuto's model order: see DEFAULT_MODELS. */
const BALANCE_MODELS = [SONNET_46, SONNET_5, KIMI]

function unique(ids: string[]): string[] {
	return [...new Set(ids)]
}

/**
 * The pool a profile may route to: its model order, then the free self-hosted
 * models, preferred ones first, plus BalanceAuto's paid models at the front for
 * the balance profile. The default profile is exclusive: it routes only to its
 * routes' own models and never falls back to the rest of the catalog, as the
 * Settings → Router "Use only these models" switch does.
 */
export function defaultPool(profile = "default"): string[] {
	const catalogIds = plinyFreePoolIds()
	const available = new Set(catalogIds)
	if (profile === "default") {
		return unique([...DEFAULT_MODELS, ...DEFAULT_ROUTES.flatMap((route) => route.use)]).filter((id) => available.has(id))
	}
	const order = profile === "fast" ? FAST_MODELS : profile === "smart" ? SMART_MODELS : []
	const preferred = profile === "fast" ? FAST_PREFERRED_HEAD : PREFERRED_HEAD
	const head = unique([...order, ...preferred]).filter((id) => available.has(id))
	const tail = catalogIds.filter((id) => !head.includes(id))
	const free = [...head, ...tail]
	if (!plinyRouterProfileAllowsPaid(profile)) {
		return free
	}
	const hosted = new Set(plinyHostedPoolIds())
	const paid = unique([...BALANCE_MODELS, ...BALANCE_PAID_HEAD]).filter((id) => hosted.has(id))
	const freeLead = BALANCE_MODELS.filter((id) => available.has(id))
	return unique([...paid, ...freeLead, ...free])
}

/**
 * Every model a profile may route to: its default pool, then for BalanceAuto
 * the paid models the catalog lists that the pool leaves out. What Settings →
 * Router offers when the user picks models.
 */
export function routableModelIds(profile = "default"): string[] {
	const pool = defaultPool(profile)
	if (!plinyRouterProfileAllowsPaid(profile)) {
		return pool
	}
	return [...pool, ...plinyHostedPoolIds().filter((id) => !pool.includes(id))]
}

/**
 * The huge-context route is the same for every free profile: the GLM replicas
 * are 512k. The vmodels replica is load-balanced and measured faster than the
 * primary, so it leads; the internal-tests replica and the primary are the
 * backups. Reasoning off: at this size GLM's default thinking dominates the
 * wait. BalanceAuto adds Sonnet 4.6's 1M window behind them.
 */
const HUGE_CONTEXT_ROUTE: RouterRoute = {
	name: "huge-context",
	tier: "huge",
	when: { minEstimatedTokens: 180_000 },
	use: [GLM_VMODELS, GLM_INTERNAL, GLM],
	effort: "quick",
}

const REASONING_PROMPT = "\\b(plan|design|architect|why|explain|review|compare|investigate|analy[sz]e)\\b"
const CODING_PROMPT =
	"\\b(fix|implement|refactor|add|edit|write|test|bug|error|compile|patch|rename|conflicts?|merge|rebase|lint|failing)\\b|type ?error|\\.(ts|tsx|py|go|rs|java|cs|js)\\b"
const QUICK_PROMPT = "^(what|how|where|which|is|does|can|list|show)\\b"

/**
 * The routes of a FreeAuto profile, built around its model order: the main
 * routes (default, coding, plan and ask reasoning) use the order, the others
 * keep lists of their own. Effort follows the thinking probe: reasoning is
 * switched off for everyday work (it multiplies latency on the models that do
 * it by default, GLM-5.2 above all) and on for planning. It only applies to
 * models whose switch was measured; every other model keeps its default.
 */
function freeRoutes(spec: { models: string[]; planModels?: string[]; subagent: string[]; quick: string[] }): RouterRoute[] {
	return [
		HUGE_CONTEXT_ROUTE,
		{
			name: "subagent",
			// Delegated tasks are bounded but multi-step (explore, then report), and
			// a sub-agent that stops early hands the parent a half result.
			when: { subAgent: true, maxEstimatedTokens: 100_000 },
			use: spec.subagent,
			effort: "quick",
		},
		{
			name: "plan-and-reasoning",
			tier: "reason",
			// Every plan-mode turn: a plan is only as good as the thinking behind it.
			when: { mode: "plan" },
			use: spec.planModels ?? spec.models,
			effort: "think",
			reasoningEffort: "high",
		},
		{
			name: "ask-reasoning",
			// Ask mode thinks only when the question asks for reasoning; a quick
			// lookup stays on the quick route.
			when: { mode: "ask", promptRegex: REASONING_PROMPT },
			use: spec.models,
			effort: "think",
			reasoningEffort: "medium",
		},
		{
			name: "coding",
			tier: "code",
			when: { mode: "act", maxEstimatedTokens: 100_000, promptRegex: CODING_PROMPT },
			use: spec.models,
			effort: "quick",
		},
		{
			name: "quick",
			tier: "quick",
			when: { maxPromptChars: 300, maxEstimatedTokens: 30_000, promptRegex: QUICK_PROMPT },
			use: spec.quick,
			effort: "quick",
		},
		{
			name: "default",
			// The catch-all gets the long multi-step tasks.
			use: spec.models,
		},
	]
}

/**
 * Routes of the default profile. Its pool is exactly these routes' models, so
 * the sub-agent and quick routes stay on kimi and nemotron super too.
 */
const DEFAULT_ROUTES = freeRoutes({
	models: DEFAULT_MODELS,
	// Planning starts the GLM replicas the other way round: the load-balanced
	// vmodels replica answers long reasoning calls faster.
	planModels: [KIMI, GLM_VMODELS, GLM_INTERNAL, NEMOTRON_ULTRA, NEMOTRON_SUPER],
	subagent: [KIMI, NEMOTRON_SUPER],
	quick: [NEMOTRON_SUPER, KIMI],
})

/** Routes of the smart profile: GLM-led, with the classifier picking the tier. */
const SMART_ROUTES = freeRoutes({
	models: SMART_MODELS,
	subagent: [KIMI, CODER, NEMOTRON_SUPER],
	quick: [QWEN_NEXT, NEMOTRON_SUPER, KIMI],
})

/** Routes of the fast profile: reasoning is switched off everywhere by `defaultRules`. */
const FAST_ROUTES = freeRoutes({
	models: FAST_MODELS,
	subagent: [CODER, QWEN_397, NEMOTRON_SUPER],
	quick: [QWEN_NEXT, CODER, NEMOTRON_SUPER],
}).filter((route) => route.name !== "ask-reasoning")

/**
 * BalanceAuto routes: Claude Sonnet 4.6 leads the main routes, with Sonnet 5 as
 * the paid failover and kimi as the free one. Short questions and sub-agent
 * runs stay free with the cheap Haiku as backup; huge requests go to the free
 * 512k GLM first, then Sonnet 4.6's 1M window. The classifier is on, so its
 * verdict, not the keyword heuristics, usually picks the tier.
 */
const BALANCE_ROUTES: RouterRoute[] = [
	{ ...HUGE_CONTEXT_ROUTE, use: [...HUGE_CONTEXT_ROUTE.use, SONNET_46] },
	{
		name: "subagent",
		when: { subAgent: true },
		use: [KIMI, CODER, HAIKU_45],
		effort: "quick",
	},
	{
		name: "plan-and-reasoning",
		tier: "reason",
		// Every plan-mode turn: plans are where paid reasoning pays off most.
		when: { mode: "plan" },
		use: BALANCE_MODELS,
		effort: "think",
		reasoningEffort: "high",
	},
	{
		name: "ask-reasoning",
		when: { mode: "ask", promptRegex: REASONING_PROMPT },
		use: BALANCE_MODELS,
		effort: "think",
		reasoningEffort: "medium",
	},
	{
		name: "coding",
		tier: "code",
		when: { mode: "act", promptRegex: CODING_PROMPT },
		use: BALANCE_MODELS,
		effort: "quick",
	},
	{
		name: "quick",
		tier: "quick",
		when: { maxPromptChars: 300, maxEstimatedTokens: 30_000, promptRegex: QUICK_PROMPT },
		use: [KIMI, NEMOTRON_SUPER, HAIKU_45],
		effort: "quick",
	},
	{
		name: "default",
		use: BALANCE_MODELS,
	},
]

function routesForProfile(profile: string): RouterRoute[] {
	if (plinyRouterProfileAllowsPaid(profile)) {
		return BALANCE_ROUTES
	}
	return profile === "fast" ? FAST_ROUTES : profile === "smart" ? SMART_ROUTES : DEFAULT_ROUTES
}

/**
 * Built-in rules for a router profile, used when its file does not exist or
 * cannot be parsed, and to seed the file on first activation.
 *
 * - default: kimi-led heuristic routes over an exclusive pool, reasoning per
 *   route, no classifier.
 * - fast: Qwen-led routes with reasoning off everywhere it can be switched off.
 * - smart: GLM-led routes plus the classifier, which picks the tier and
 *   whether to think once per turn.
 * - balance: Claude Sonnet 4.6 on the main routes, free models for
 *   sub-agents and simple work, with the classifier on so the split is decided
 *   per turn.
 */
export function defaultRules(profile = "default"): RouterRules {
	const balance = plinyRouterProfileAllowsPaid(profile)
	const routes = routesForProfile(profile).map((route) => ({
		...route,
		use: [...route.use],
		...(route.when ? { when: { ...route.when } } : {}),
	}))
	if (profile === "fast") {
		for (const route of routes) {
			route.effort = "quick"
			delete route.reasoningEffort
		}
	}
	return {
		version: 1,
		pool: defaultPool(profile),
		utility: { ...DEFAULT_UTILITY },
		classifier: { ...DEFAULT_CLASSIFIER, enabled: profile === "smart" || balance },
		guard: { ...DEFAULT_GUARD },
		health: { ...DEFAULT_HEALTH },
		escalation: { ...DEFAULT_ESCALATION },
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
		const id = asString(entry)
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
		const id = asString(value)
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
