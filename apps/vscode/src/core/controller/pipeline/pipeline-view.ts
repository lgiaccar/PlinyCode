import { PipelineHistory } from "@shared/proto/cline/pipeline"
import { getPipelineManager } from "@/services/devops-mcp/builtin-mcp-registry"
import { DevOpsError } from "@/services/devops-mcp/server/errors"

export function requirePipelineManager() {
	const manager = getPipelineManager()
	if (!manager) throw new DevOpsError("Pipelines are still starting. Reopen this view in a moment.")
	return manager
}

export function pipelineHistory(): PipelineHistory {
	const manager = getPipelineManager()
	return PipelineHistory.create({
		unavailable: manager ? "" : "Pipelines are still starting. Reopen this view in a moment.",
		launches:
			manager?.view().map((record) => ({
				id: record.id,
				pipelineName: record.pipeline.name,
				repoRoot: record.repoRoot,
				ref: record.ref,
				created: record.created,
				status:
					record.run?.status ??
					(record.state === "accepted" ? (record.runId ? "queued" : "awaiting_identification") : record.state),
				result: record.run?.result ?? "",
				url: record.url,
				runId: record.runId ?? 0,
				updated: record.updated ?? 0,
				error: record.error ?? "",
				needsAssociation: !record.runId && ["accepted", "unknown"].includes(record.state),
				provider: record.provider,
			})) ?? [],
	})
}
