import type { EmptyRequest } from "@shared/proto/cline/common"
import { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { requestPlinyBudget } from "@/sdk/pliny-budget"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Reads the caller's Pliny budget from the gateway. Uses the same key and
 * host as chat requests: the active key from Settings (or the one in
 * providers.json), else PLINY_API_KEY; the gateway origin of the configured
 * base URL.
 */
export async function getPlinyBudget(controller: Controller, _request: EmptyRequest): Promise<PlinyBudgetResponse> {
	const unavailable = (error: string) => PlinyBudgetResponse.create({ available: false, error })
	try {
		const config = controller.getProviderConfigStore().read(parseProviderId("pliny"))
		const apiKey = config.apiKey?.trim() || process.env.PLINY_API_KEY?.trim()
		if (!apiKey) {
			return unavailable("No Pliny API key")
		}
		const { status, budget } = await requestPlinyBudget(apiKey, config)
		if (status < 200 || status >= 300) {
			return unavailable(`Pliny budget request failed: HTTP ${status}`)
		}
		if (!budget) {
			return unavailable("No Pliny budget applies to this account")
		}
		return PlinyBudgetResponse.create({
			available: true,
			limit: budget.limit,
			used: budget.used,
			remaining: budget.remaining,
			percentage: budget.percentage,
			period: budget.period,
			periodEndMs: budget.periodEndMs,
			isBlocked: budget.isBlocked,
		})
	} catch (error) {
		Logger.warn(`[getPlinyBudget] ${error instanceof Error ? error.message : String(error)}`)
		return unavailable(error instanceof Error ? error.message : String(error))
	}
}
