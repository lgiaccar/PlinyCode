import { Empty, type EmptyRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function refreshPipelineRuns(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	await requirePipelineManager().refresh()
	return Empty.create({})
}
