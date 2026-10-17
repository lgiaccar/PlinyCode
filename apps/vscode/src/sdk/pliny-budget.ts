import { PLINY_BASE_URL, PLINY_DEFAULT_HEADERS } from "@plinycode/llms"
import { PLINY_BUDGET_PATH, parsePlinyBudget } from "@/shared/plinyBudget"
import { createPlinyFetch } from "./pliny-fetch"

const BUDGET_TIMEOUT_MS = 15_000

interface PlinyGatewayConfig {
	baseUrl?: string
	headers?: Readonly<Record<string, string>>
}

/**
 * Asks the gateway for `apiKey`'s budget (src/shared/plinyBudget.ts). The
 * status tells a rejected key (401/403) from an accepted one; `budget` is
 * undefined when the request failed or no budget applies to the account.
 * Network errors are thrown.
 */
export async function requestPlinyBudget(
	apiKey: string,
	config: PlinyGatewayConfig = {},
	timeoutMs = BUDGET_TIMEOUT_MS,
): Promise<{ status: number; budget?: ReturnType<typeof parsePlinyBudget> }> {
	const baseUrl = process.env.PLINY_BASE_URL || config.baseUrl?.trim() || PLINY_BASE_URL
	const url = `${new URL(baseUrl).origin}${PLINY_BUDGET_PATH}`
	const response = await createPlinyFetch(timeoutMs)(url, {
		method: "GET",
		headers: { ...PLINY_DEFAULT_HEADERS, ...(config.headers ?? {}), Authorization: `Bearer ${apiKey}` },
	})
	if (!response.ok) {
		return { status: response.status }
	}
	return { status: response.status, budget: parsePlinyBudget(await response.json()) }
}
