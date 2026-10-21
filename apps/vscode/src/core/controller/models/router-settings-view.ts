import {
	buildPlinyModels,
	isPlinySelfHostedModelId,
	type ModelInfo,
	PLINY_ROUTER_PROFILES,
	plinyRouterBudget,
} from "@plinycode/llms"
import { RouterSettingsResponse } from "@shared/proto/cline/models"
import {
	isRouterTuningProfile,
	normalizeRouterTuning,
	type RouterModelOption,
	type RouterProfileView,
	type RouterSettingsView,
} from "@shared/router-tuning"
import type { StateManager } from "@/core/storage/StateManager"
import { routableModelIds } from "@/sdk/router/router-rules"
import { loadRouterRules } from "@/sdk/router/router-rules-store"
import { routerBaseView } from "@/sdk/router/router-tuning"

/** What the Settings → Router handlers need from the controller. */
export interface RouterSettingsController {
	stateManager: Pick<StateManager, "getGlobalStateKey" | "reloadGlobalStateKey" | "setGlobalState">
	getWorkspaceRoot(): Promise<string>
	/** Sends the new tuning to the chat, whose context bar marks the tuned compaction budget. */
	postStateToWebview?(): Promise<void>
}

function modelOption(id: string, models: Record<string, ModelInfo>): RouterModelOption {
	const info = models[id]
	return {
		id,
		name: info?.name ?? id,
		free: isPlinySelfHostedModelId(id),
		...(info?.contextWindow ? { contextWindow: info.contextWindow } : {}),
		...(info?.maxTokens ? { outputReserve: info.maxTokens } : {}),
		...(info?.capabilities?.includes("images") ? { images: true } : {}),
	}
}

/**
 * Every router profile as Settings → Router shows it: the rules its files
 * give it (the defaults each field falls back to), its tuning, and the models
 * it may route to. Ids the rules or the tuning name that the catalog no longer
 * lists are offered too, so the form can show and remove them.
 */
async function buildRouterSettingsView(controller: RouterSettingsController): Promise<RouterSettingsView> {
	const tuning = normalizeRouterTuning(controller.stateManager.getGlobalStateKey("routerTuning"))
	const workspaceRoot = await controller.getWorkspaceRoot().catch(() => undefined)
	const models = buildPlinyModels()
	const profiles: RouterProfileView[] = []
	for (const spec of PLINY_ROUTER_PROFILES) {
		const profile = spec.profile
		if (!isRouterTuningProfile(profile)) {
			continue
		}
		const rules = await loadRouterRules({ workspaceRoot, profile })
		const base = routerBaseView(rules)
		const own = tuning[profile] ?? {}
		const named = [
			...base.models,
			...base.routes.flatMap((route) => route.use),
			...(own.models ?? []),
			...Object.values(own.routes ?? {}).flatMap((route) => route.use ?? []),
		]
		const ids = [...new Set([...routableModelIds(profile), ...named])]
		profiles.push({
			profile,
			label: spec.label,
			modelId: spec.id,
			compactionBudget: plinyRouterBudget(profile)?.maxInputTokens ?? models[spec.id]?.maxInputTokens ?? 0,
			base,
			tuning: own,
			candidates: ids.map((id) => modelOption(id, models)),
		})
	}
	return { profiles }
}

export async function routerSettingsResponse(controller: RouterSettingsController): Promise<RouterSettingsResponse> {
	return RouterSettingsResponse.create({ settingsJson: JSON.stringify(await buildRouterSettingsView(controller)) })
}
