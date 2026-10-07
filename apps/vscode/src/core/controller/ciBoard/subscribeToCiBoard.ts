import type { CiBoardState } from "@shared/proto/cline/ci_board"
import type { EmptyRequest } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"
import { toProtoCiBoard } from "./ci-board-view"

/** Streams the CI board to its view; the board polls faster while a view is subscribed. */
export async function subscribeToCiBoard(
	controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<CiBoardState>,
	requestId?: string,
): Promise<void> {
	const board = getCiBoard()
	if (!board) {
		await responseStream(toProtoCiBoard(controller, undefined), false)
		return
	}
	const release = board.openView()
	const send = () =>
		responseStream(toProtoCiBoard(controller, board), false).catch((error) => {
			Logger.error("Error sending the CI board:", error)
			dispose()
		})
	const unsubscribe = board.onDidChange(() => void send())
	const dispose = () => {
		unsubscribe()
		release()
	}
	if (requestId) {
		getRequestRegistry().registerRequest(requestId, dispose, { type: "ciBoard_subscription" }, responseStream)
	}
	await send()
}
