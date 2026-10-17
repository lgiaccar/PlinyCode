import { getCustomizationChangeNotifier } from "@core/context/instructions/user-instructions/customization-watcher"
import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

/**
 * Streams an empty event after each burst of changes to the rules, skills,
 * hooks and agents folders, for as long as the Rules panel is open. The panel
 * refreshes on each event; the watchers stop when it unsubscribes.
 */
export async function subscribeToCustomizationChanges(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	const notifier = getCustomizationChangeNotifier()
	if (!notifier) {
		return
	}
	const unsubscribe = notifier.subscribe(() => {
		responseStream(Empty.create({}), false).catch((error) => {
			Logger.error("[customization-watcher] Failed to notify the Rules panel:", error)
			unsubscribe()
		})
	})
	if (requestId) {
		getRequestRegistry().registerRequest(
			requestId,
			unsubscribe,
			{ type: "customization_changes_subscription" },
			responseStream,
		)
	}
}
