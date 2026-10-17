import { Empty } from "@shared/proto/cline/common"
import type { PipelineRunAction } from "@shared/proto/cline/pipeline"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function cancelPipelineRun(_controller: Controller, request: PipelineRunAction): Promise<Empty> {
	await requirePipelineManager().cancel(request.id)
	return Empty.create({})
}
