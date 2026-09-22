import { LatestChangesSummary } from "@shared/proto/cline/checkpoints"
import { EmptyRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

export async function checkpointLatestChangesSummary(
	controller: Controller,
	_request: EmptyRequest,
): Promise<LatestChangesSummary> {
	const sdkGetLatestCheckpointChangesSummary = (
		controller as Controller & {
			getLatestCheckpointChangesSummary?: () => Promise<LatestChangesSummary>
		}
	).getLatestCheckpointChangesSummary
	if (sdkGetLatestCheckpointChangesSummary) {
		return await sdkGetLatestCheckpointChangesSummary.call(controller)
	}
	return LatestChangesSummary.create({ files: [], totalAdded: 0, totalRemoved: 0, checkpointRunCount: 0 })
}
