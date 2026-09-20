import { useCallback, useMemo } from "react"
import { buildClinePassSubscribeUrl, buildClinePassSubscriptionPageUrl } from "@/components/onboarding/clinePassSubscribe"
import { useClineAuth } from "@/context/ClineAuthContext"

export const CLINE_PASS_PROVIDER_ID = "cline-pass"

/**
 * ClinePass promotions are disabled in PlinyCode (no accounts / subscriptions).
 * Hook kept as a no-op so remaining call sites compile without showing ads.
 */
export function useClinePassPromo() {
	const { clineUser } = useClineAuth()

	const subscribeUrl = useMemo(() => buildClinePassSubscribeUrl(clineUser?.appBaseUrl), [clineUser?.appBaseUrl])
	const manageSubscriptionUrl = useMemo(() => buildClinePassSubscriptionPageUrl(clineUser?.appBaseUrl), [clineUser?.appBaseUrl])

	const noop = useCallback(() => {}, [])
	const selectClinePassProvider = useCallback(async (): Promise<boolean> => false, [])
	const switchToClinePassProvider = useCallback(async () => {}, [])

	return {
		isClinePassEnabled: false,
		isUsingClinePass: false,
		subscribeUrl,
		manageSubscriptionUrl,
		openSubscribePage: noop,
		openManageSubscriptionPage: noop,
		selectClinePassProvider,
		switchToClinePassProvider,
	}
}
