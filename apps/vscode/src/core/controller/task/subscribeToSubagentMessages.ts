import type { ClineMessage } from "@shared/ExtensionMessage"
import { type SubagentMessagesRequest, SubagentMessagesUpdate } from "@shared/proto/cline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"

function toUpdate(reset: boolean, messages: ClineMessage[]): SubagentMessagesUpdate {
	return SubagentMessagesUpdate.create({ reset, messages: messages.map(convertClineMessageToProto) })
}

/**
 * Streams one sub-agent's live transcript to an expanded item of the sub-agents
 * row: first everything kept so far (`reset`), then each added or changed message.
 * The stream ends when the webview cancels it (the item collapses or unmounts).
 */
export async function subscribeToSubagentMessages(
	controller: Controller,
	request: SubagentMessagesRequest,
	responseStream: StreamingResponseHandler<SubagentMessagesUpdate>,
	requestId?: string,
): Promise<void> {
	const agentId = request.agentId
	const transcripts = controller.getSubagentTranscripts()
	let unsubscribe: (() => void) | undefined
	const dispose = () => {
		unsubscribe?.()
		unsubscribe = undefined
	}
	const send = (update: SubagentMessagesUpdate) =>
		responseStream(update, false).catch((error) => {
			Logger.error("Error sending a sub-agent transcript update:", error)
			dispose()
		})

	// Subscribing, taking the snapshot and starting its send happen in one
	// synchronous step, so no change can fall between them or overtake the snapshot.
	unsubscribe = transcripts.subscribe(agentId, (update) => void send(toUpdate(update.reset, update.messages)))
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, dispose, { type: "subagent_messages_subscription" }, responseStream)
	}
	await send(toUpdate(true, transcripts.snapshot(agentId)))
}
