/**
 * Settings → Router laid over the rules files. The rules a profile routes by
 * are its built-in defaults, then its rules files (global, then workspace),
 * then this tuning, which changes only the fields it sets. Pure, so the
 * overlay can be tested without a session.
 */

import { plinyRouterProfileAllowsPaid } from "@plinycode/llms"
import {
	normalizeRouterProfileTuning,
	ROUTER_MAIN_ROUTES,
	type RouterBaseView,
	type RouterProfileTuning,
	type RouterRouteTuning,
} from "@/shared/router-tuning"
import { sanitizeModelIds } from "./router-rules"
import type { RouterRoute, RouterRules } from "./router-types"

const MAIN_ROUTES: ReadonlySet<string> = new Set(ROUTER_MAIN_ROUTES)

function unique(ids: string[]): string[] {
	return [...new Set(ids)]
}

function tuneRoute(
	route: RouterRoute,
	models: string[],
	override: RouterRouteTuning | undefined,
	allowPaid: boolean,
): RouterRoute {
	const own = sanitizeModelIds(override?.use, allowPaid)
	const use = own.length > 0 ? own : models.length > 0 && MAIN_ROUTES.has(route.name) ? models : route.use
	const tuned: RouterRoute = { ...route, use: [...use], ...(route.when ? { when: { ...route.when } } : {}) }
	if (override?.effort === "default") {
		delete tuned.effort
		delete tuned.reasoningEffort
	} else if (override?.effort) {
		tuned.effort = override.effort
	}
	if (override?.reasoningEffort && tuned.effort === "think") {
		tuned.reasoningEffort = override.reasoningEffort
	}
	for (const bound of ["minEstimatedTokens", "maxEstimatedTokens", "maxPromptChars"] as const) {
		const value = override?.[bound]
		if (value !== undefined) {
			tuned.when = { ...tuned.when, [bound]: value }
		}
	}
	return tuned
}

/**
 * The rules with a profile's tuning applied:
 *
 * - `models` becomes the list of the main routes (default, coding, plan and
 *   ask reasoning) and heads the pool; the sub-agent, quick and huge-context
 *   routes keep their own lists unless overridden by name.
 * - `exclusive` limits the pool to `models` plus the routes' overrides, so the
 *   router never falls back to the rest of the catalog.
 * - Everything else replaces the field it names.
 *
 * Model ids go through the rules files' own filter: a FreeAuto profile drops
 * paid ids, and a router id is never routable.
 */
export function applyRouterTuning(rules: RouterRules, tuning: RouterProfileTuning | undefined, profile: string): RouterRules {
	if (!tuning) {
		return rules
	}
	const allowPaid = plinyRouterProfileAllowsPaid(profile)
	const models = sanitizeModelIds(tuning.models, allowPaid)
	const overrides = tuning.routes ?? {}
	const routes = rules.routes.map((route) => tuneRoute(route, models, overrides[route.name], allowPaid))
	const overrideIds = Object.values(overrides).flatMap((route) => sanitizeModelIds(route.use, allowPaid))
	const pool =
		tuning.exclusive && models.length > 0
			? unique([...models, ...overrideIds])
			: unique([...models, ...rules.pool, ...overrideIds])
	const utilityModel = (id: string | undefined, fallback: string) => sanitizeModelIds(id ? [id] : [], allowPaid)[0] ?? fallback
	const classifierModel = utilityModel(tuning.utility?.classifier, rules.utility.classifier)
	return {
		...rules,
		pool,
		routes,
		utility: {
			classifier: classifierModel,
			// As in a rules file, a judge left unset follows a changed classifier.
			judge: utilityModel(tuning.utility?.judge, tuning.utility?.classifier ? classifierModel : rules.utility.judge),
			summarizer: utilityModel(tuning.utility?.summarizer, rules.utility.summarizer),
			commit: utilityModel(tuning.utility?.commit, rules.utility.commit),
		},
		classifier: { ...rules.classifier, ...tuning.classifier },
		guard: { ...rules.guard, ...tuning.guard },
		health: { ...rules.health, ...tuning.health },
		escalation: { ...rules.escalation, ...tuning.escalation },
		sticky: tuning.sticky ?? rules.sticky,
		contextMarginRatio: tuning.contextMarginRatio ?? rules.contextMarginRatio,
	}
}

/**
 * `applyRouterTuning` remembered per rules object and stored tuning, so a call
 * does not rebuild the rules while neither changed. The stored value is
 * normalized here because global state is a file anyone can edit.
 */
export function createTunedRules(): (rules: RouterRules, tuning: unknown, profile: string) => RouterRules {
	const cache = new WeakMap<RouterRules, { tuning: unknown; profile: string; rules: RouterRules }>()
	return (rules, tuning, profile) => {
		const hit = cache.get(rules)
		if (hit && hit.tuning === tuning && hit.profile === profile) {
			return hit.rules
		}
		const tuned = applyRouterTuning(rules, normalizeRouterProfileTuning(tuning), profile)
		cache.set(rules, { tuning, profile, rules: tuned })
		return tuned
	}
}

/** The rules as Settings shows them before any tuning: the defaults each field falls back to. */
export function routerBaseView(rules: RouterRules): RouterBaseView {
	return {
		models: [...(rules.routes.find((route) => route.name === "default")?.use ?? rules.pool.slice(0, 4))],
		routes: rules.routes.map((route) => ({
			name: route.name,
			use: [...route.use],
			...(route.effort ? { effort: route.effort } : {}),
			...(route.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}),
			...(route.when?.minEstimatedTokens !== undefined ? { minEstimatedTokens: route.when.minEstimatedTokens } : {}),
			...(route.when?.maxEstimatedTokens !== undefined ? { maxEstimatedTokens: route.when.maxEstimatedTokens } : {}),
			...(route.when?.maxPromptChars !== undefined ? { maxPromptChars: route.when.maxPromptChars } : {}),
		})),
		classifier: { enabled: rules.classifier.enabled, timeoutMs: rules.classifier.timeoutMs },
		guard: { ...rules.guard },
		health: {
			cooldownMs: rules.health.cooldownMs,
			failuresBeforeCooldown: rules.health.failuresBeforeCooldown,
			maxFailoversPerTurn: rules.health.maxFailoversPerTurn,
			firstTokenTimeoutMs: rules.health.firstTokenTimeoutMs,
			stallTimeoutMs: rules.health.stallTimeoutMs,
		},
		escalation: { ...rules.escalation },
		utility: { ...rules.utility },
		sticky: rules.sticky,
		contextMarginRatio: rules.contextMarginRatio,
	}
}
