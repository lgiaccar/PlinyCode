import { Empty } from "@shared/proto/cline/common"
import { SetTaskSpendingLimitRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../"

export async function setTaskSpendingLimit(controller: Controller, request: SetTaskSpendingLimitRequest): Promise<Empty> {
	if (!request.taskId || !Number.isFinite(request.limit) || request.limit < 0) {
		Logger.error(`[setTaskSpendingLimit] Invalid request: taskId missing or invalid limit ${request.limit}`)
		return Empty.create({})
	}

	try {
		await controller.setTaskSpendingLimit(request.taskId, request.limit)
		return Empty.create({})
	} catch (error) {
		Logger.error("Error in setTaskSpendingLimit:", error)
		throw error
	}
}
