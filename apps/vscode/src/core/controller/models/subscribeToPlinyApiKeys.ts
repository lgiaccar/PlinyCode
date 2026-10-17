import type { EmptyRequest } from "@shared/proto/cline/common"
import type { PlinyApiKeys } from "@shared/proto/cline/models"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Streams the stored Pliny API keys to Settings, again after every change (in any window). */
export async function subscribeToPlinyApiKeys(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<PlinyApiKeys>,
	requestId?: string,
): Promise<void> {
	const keys = getPlinyApiKeys()
	const send = () =>
		responseStream(toProtoPlinyApiKeys(keys), false).catch((error) => {
			Logger.error("Error sending Pliny API keys:", error)
			subscription?.dispose()
		})
	const subscription = keys?.onDidChange(() => void send())
	if (requestId && subscription) {
		getRequestRegistry().registerRequest(
			requestId,
			() => subscription.dispose(),
			{ type: "plinyApiKeys_subscription" },
			responseStream,
		)
	}
	await keys?.ready
	await send()
}
