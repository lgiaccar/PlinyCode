import type { EmptyRequest } from "@shared/proto/cline/common"
import type { PipelineHistory } from "@shared/proto/cline/pipeline"
import { getPipelineManager } from "@/services/devops-mcp/builtin-mcp-registry"
import { Logger } from "@/shared/services/Logger"
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import type { Controller } from "../index"
import { pipelineHistory } from "./pipeline-view"

export async function subscribeToPipelineRuns(
	_controller: Controller,
	_request: EmptyRequest,
	responseStream: StreamingResponseHandler<PipelineHistory>,
	requestId?: string,
): Promise<void> {
	const manager = getPipelineManager()
	if (!manager) {
		await responseStream(pipelineHistory(), false)
		return
	}
	const release = manager.openView()
	let unsubscribe = () => {}
	const dispose = () => {
		unsubscribe()
		release()
	}
	const send = () =>
		responseStream(pipelineHistory(), false).catch((error) => {
			Logger.error("[Pipelines] Subscription failed:", error)
			dispose()
		})
	unsubscribe = manager.onDidChange(() => void send())
	if (requestId) getRequestRegistry().registerRequest(requestId, dispose, { type: "pipeline_subscription" }, responseStream)
	await send()
}
