import { String as StringMessage } from "@shared/proto/cline/common"
import type { QueuePipelineRequest } from "@shared/proto/cline/pipeline"
import { DevOpsError } from "@/services/devops-mcp/server/errors"
import type { Controller } from "../index"
import { requirePipelineManager } from "./pipeline-view"

export async function queuePipelineRun(_controller: Controller, request: QueuePipelineRequest): Promise<StringMessage> {
	if (request.inputsJson.length > 100_000) throw new DevOpsError("Pipeline inputs exceed the allowed size.")
	let inputs: unknown
	try {
		inputs = JSON.parse(request.inputsJson || "{}")
	} catch {
		throw new DevOpsError("Pipeline inputs must be valid JSON.")
	}
	if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
		throw new DevOpsError("Pipeline inputs must be an object.")
	const record = await requirePipelineManager().queue({
		id: request.id,
		repoRoot: request.repoRoot,
		pipelineId: request.pipelineId,
		ref: request.ref,
		revision: request.revision,
		inputs: inputs as Record<string, unknown>,
	})
	return StringMessage.create({ value: record.id })
}
