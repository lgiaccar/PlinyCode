import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, StreamingResponseHandler } from "../grpc-handler"
import { Controller } from "../index"

const activeSubscriptions = new Set<StreamingResponseHandler<Empty>>()

/** Subscribes the webview to clicks on the CI Board button in the view's title bar. */
export async function subscribeToCiBoardButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	activeSubscriptions.add(responseStream)
	const cleanup = () => {
		activeSubscriptions.delete(responseStream)
	}
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, cleanup, { type: "ci_board_button_clicked_subscription" }, responseStream)
	}
}

/** Tells the webview to show the CI board. */
export async function sendCiBoardButtonClickedEvent(): Promise<void> {
	await Promise.all(
		Array.from(activeSubscriptions).map(async (responseStream) => {
			try {
				await responseStream(Empty.create({}), false)
			} catch (error) {
				Logger.error("Error sending CI board button clicked event:", error)
				activeSubscriptions.delete(responseStream)
			}
		}),
	)
}
