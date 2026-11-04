import type { EmptyRequest } from "@shared/proto/cline/common"
import { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { parseProviderId } from "@/sdk/model-catalog/provider-id"
import { waitForPlinyApiKeys } from "@/sdk/pliny-api-key-source"
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
		await waitForPlinyApiKeys()
		const config = controller.getProviderConfigStore().read(parseProviderId("pliny"))
		const apiKey = config.apiKey?.trim() || process.env.PLINY_API_KEY?.trim()
		if (!apiKey) {
			return unavailable("No Pliny API key")
		}
		// Budget aggregation can take longer than key validation's default timeout.
		const { status, budget } = await requestPlinyBudget(apiKey, config, 30_000)
		if (status < 200 || status >= 300) {
			return unavailable(
				status === 401 || status === 403
					? `The gateway rejected the budget request (HTTP ${status}). Check your active Pliny API key in Settings.`
					: `The budget service is unavailable (HTTP ${status}). Retrying automatically.`,
			)
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
		return unavailable(
			error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")
				? "The budget request timed out. Retrying automatically."
				: "Could not reach the budget service. Check your network/VPN connection; retrying automatically.",
		)
	}
}
