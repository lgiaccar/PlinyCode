import { Empty } from "@shared/proto/cline/common"
import { TaskPinRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../"

export async function toggleTaskPin(controller: Controller, request: TaskPinRequest): Promise<Empty> {
	if (!request.taskId) {
		Logger.error(`[toggleTaskPin] Invalid request: taskId missing`)
		return Empty.create({})
	}

	try {
		await controller.toggleTaskPin(request.taskId, request.isPinned)
		return Empty.create({})
	} catch (error) {
		Logger.error("Error in toggleTaskPin:", error)
		throw error
	}
}
