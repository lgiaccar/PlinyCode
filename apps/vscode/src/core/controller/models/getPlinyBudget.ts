import { PLINY_BASE_URL, PLINY_DEFAULT_HEADERS } from "@plinycode/llms"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { createPlinyFetch } from "@/sdk/pliny-fetch"
import { PLINY_BUDGET_PATH, parsePlinyBudget } from "@/shared/plinyBudget"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const BUDGET_TIMEOUT_MS = 15_000

/**
 * Reads the caller's Pliny budget from the gateway. Uses the same key and
 * host as chat requests: the key saved for the Pliny provider, else
 * PLINY_API_KEY; the gateway origin of the configured base URL.
 */
export async function getPlinyBudget(controller: Controller, _request: EmptyRequest): Promise<PlinyBudgetResponse> {
	const unavailable = (error: string) => PlinyBudgetResponse.create({ available: false, error })
	try {
		const config = controller.getProviderConfigStore().read(parseProviderId("pliny"))
		const apiKey = config.apiKey?.trim() || process.env.PLINY_API_KEY?.trim()
		if (!apiKey) {
			return unavailable("No Pliny API key")
		}
		const baseUrl = process.env.PLINY_BASE_URL || config.baseUrl?.trim() || PLINY_BASE_URL
		const url = `${new URL(baseUrl).origin}${PLINY_BUDGET_PATH}`
		const response = await createPlinyFetch(BUDGET_TIMEOUT_MS)(url, {
			method: "GET",
			headers: { ...PLINY_DEFAULT_HEADERS, ...(config.headers ?? {}), Authorization: `Bearer ${apiKey}` },
		})
		if (!response.ok) {
			return unavailable(`Pliny budget request failed: HTTP ${response.status}`)
		}
		const budget = parsePlinyBudget(await response.json())
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
