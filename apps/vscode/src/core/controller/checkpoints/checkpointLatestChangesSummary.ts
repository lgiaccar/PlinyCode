import { CheckpointChangesSummaryRequest, LatestChangesSummary } from "@shared/proto/cline/checkpoints"
import { Controller } from ".."

export async function checkpointLatestChangesSummary(
	controller: Controller,
	request: CheckpointChangesSummaryRequest,
): Promise<LatestChangesSummary> {
	const sdkGetCheckpointChangesSummary = (
		controller as Controller & {
			getCheckpointChangesSummary?: (input?: {
				checkpointRunCount?: number
				messageTs?: number
			}) => Promise<LatestChangesSummary>
			getLatestCheckpointChangesSummary?: () => Promise<LatestChangesSummary>
		}
	).getCheckpointChangesSummary
	if (sdkGetCheckpointChangesSummary) {
		return await sdkGetCheckpointChangesSummary.call(controller, {
			checkpointRunCount: request.checkpointRunCount,
			messageTs: request.messageTs,
		})
	}
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
