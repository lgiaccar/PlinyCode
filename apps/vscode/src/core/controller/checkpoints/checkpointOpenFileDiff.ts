import { OpenFileDiffRequest } from "@shared/proto/cline/checkpoints"
import { Empty } from "@shared/proto/cline/common"
import { Controller } from ".."

export async function checkpointOpenFileDiff(controller: Controller, request: OpenFileDiffRequest): Promise<Empty> {
	const sdkOpenCheckpointFileDiff = (
		controller as Controller & {
			openCheckpointFileDiff?: (filePath: string, checkpointRunCount: number) => Promise<void>
		}
	).openCheckpointFileDiff
	if (sdkOpenCheckpointFileDiff) {
		await sdkOpenCheckpointFileDiff.call(controller, request.filePath, request.checkpointRunCount)
	}
	return Empty.create({})
}
