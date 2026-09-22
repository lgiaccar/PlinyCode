import { PLINY_FEATURED_MODELS } from "@/shared/pliny"

interface ClineRecommendedModelData {
	id: string
	name: string
	description: string
	tags: string[]
}

export interface ClineRecommendedModelsData {
	recommended: ClineRecommendedModelData[]
	free: ClineRecommendedModelData[]
	clinePass?: ClineRecommendedModelData[]
}

/**
 * PlinyCode: never fetch Cline cloud recommended models (gpt-6, grok-4.5, …).
 * Return the verified Pliny catalog subset instead.
 */
export async function refreshClineRecommendedModels(): Promise<ClineRecommendedModelsData> {
	const recommended = PLINY_FEATURED_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		description: model.description,
		tags: [...model.tags],
	}))
	return { recommended, free: [], clinePass: [] }
}

export function resetClineRecommendedModelsCacheForTests(): void {
	// No cache in PlinyCode.
}
