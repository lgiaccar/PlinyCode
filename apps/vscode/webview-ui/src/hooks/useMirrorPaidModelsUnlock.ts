import { UpdateSettingsRequest } from "@shared/proto/cline/state"
import { useEffect } from "react"
import { plinyUnlockPaidStore } from "@/components/settings/utils/plinyModelFilter"
import { StateServiceClient } from "@/services/grpc-client"

function send(unlocked: boolean): void {
	StateServiceClient.updateSettings(UpdateSettingsRequest.create({ plinyPaidModelsUnlocked: unlocked })).catch((error) =>
		console.error("Failed to mirror the paid-models toggle:", error),
	)
}

/**
 * "Unlock Pliny paid models" lives in the webview's localStorage, where the
 * extension cannot read it. The routers need it, to know whether a FreeAuto
 * conversation may have an image described by a paid model
 * (`plinycode.router.images`), so it is sent to the extension when the
 * webview loads and whenever it changes.
 */
export function useMirrorPaidModelsUnlock(): void {
	useEffect(() => {
		let last = plinyUnlockPaidStore.get()
		send(last)
		return plinyUnlockPaidStore.subscribe(() => {
			const next = plinyUnlockPaidStore.get()
			if (next !== last) {
				last = next
				send(next)
			}
		})
	}, [])
}
