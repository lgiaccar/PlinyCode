import { PLINY_FEATURED_MODELS } from "./pliny"

interface ClineRecommendedModel {
	id: string
	name: string
	description: string
	tags: string[]
}

export interface ClineRecommendedModelsData {
	recommended: ClineRecommendedModel[]
	free: ClineRecommendedModel[]
}

/**
 * PlinyCode fallback for any UI still reading the old Cline recommended list.
 */
export const CLINE_RECOMMENDED_MODELS_FALLBACK: ClineRecommendedModelsData = {
	recommended: PLINY_FEATURED_MODELS.map((model) => ({
		id: model.id,
		name: model.name,
		description: model.description,
		tags: [...model.tags],
	})),
	free: [],
}
