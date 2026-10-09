import { PipelineInputSchema, type PipelineSelection } from "@shared/proto/cline/pipeline"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function getPipelineInputs(_controller: Controller, request: PipelineSelection): Promise<PipelineInputSchema> {
	const schema = await requirePipelineManager().inputs(request.repoRoot, request.pipelineId, request.ref)
	return PipelineInputSchema.create({
		revision: schema.revision,
		limitations: schema.limitations,
		parameters: schema.inputs.map((input) => ({
			name: input.name,
			label: input.label,
			type: input.type,
			required: input.required,
			defaultJson: Object.hasOwn(input, "default") ? JSON.stringify(input.default) : "",
			optionsJson: input.options?.map((option) => JSON.stringify(option)) ?? [],
		})),
	})
}
