import { CLINE_ONBOARDING_MODELS } from "@/shared/cline/onboarding"
import { OnboardingModelGroup } from "@/shared/proto/cline/state"

export function getClineOnboardingModels(): OnboardingModelGroup {
	return { models: [...CLINE_ONBOARDING_MODELS] }
}
