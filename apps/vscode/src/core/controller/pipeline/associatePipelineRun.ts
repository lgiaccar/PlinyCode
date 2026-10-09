import { Empty } from "@shared/proto/cline/common"
import type { AssociatePipelineRequest } from "@shared/proto/cline/pipeline"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function associatePipelineRun(_controller: Controller, request: AssociatePipelineRequest): Promise<Empty> {
	await requirePipelineManager().associate(request.id, request.runId)
	return Empty.create({})
}
