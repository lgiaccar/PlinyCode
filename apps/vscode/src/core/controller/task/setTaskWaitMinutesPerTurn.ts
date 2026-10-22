import { Empty } from "@shared/proto/cline/common"
import { SetTaskWaitMinutesPerTurnRequest } from "@shared/proto/cline/task"
import { Controller } from "../"

export async function setTaskWaitMinutesPerTurn(
	controller: Controller,
	request: SetTaskWaitMinutesPerTurnRequest,
): Promise<Empty> {
	if (!request.taskId || !Number.isFinite(request.minutes) || request.minutes < 0) {
		throw new Error("Invalid conversation wait limit")
	}
	await controller.setTaskWaitMinutesPerTurn(request.taskId, request.minutes)
	return Empty.create({})
}
