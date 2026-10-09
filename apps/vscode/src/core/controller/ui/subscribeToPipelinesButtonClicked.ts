import { Empty, type EmptyRequest } from "@shared/proto/cline/common"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

const subscriptions = new Set<StreamingResponseHandler<Empty>>()

export async function subscribeToPipelinesButtonClicked(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<Empty>,
	requestId?: string,
): Promise<void> {
	subscriptions.add(responseStream)
	if (requestId)
		getRequestRegistry().registerRequest(
			requestId,
			() => subscriptions.delete(responseStream),
			{ type: "pipelines_button_subscription" },
			responseStream,
		)
}

export async function sendPipelinesButtonClickedEvent(): Promise<void> {
	await Promise.all(
		[...subscriptions].map(async (responseStream) => {
			try {
				await responseStream(Empty.create({}), false)
			} catch (error) {
				Logger.error("[Pipelines] Navigation event failed:", error)
				subscriptions.delete(responseStream)
			}
		}),
	)
}
