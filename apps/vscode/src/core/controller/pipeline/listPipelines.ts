import type { StringRequest } from "@shared/proto/cline/common"
import { PipelineList } from "@shared/proto/cline/pipeline"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function listPipelines(_controller: Controller, request: StringRequest): Promise<PipelineList> {
	const manager = requirePipelineManager()
	const [pipelines, defaultRef] = await Promise.all([manager.listPipelines(request.value), manager.defaultRef(request.value)])
	return PipelineList.create({ pipelines, defaultRef })
}
