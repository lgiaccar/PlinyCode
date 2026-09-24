import { Empty } from "@shared/proto/cline/common"
import { RenameTaskRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from "../"

export async function renameTask(controller: Controller, request: RenameTaskRequest): Promise<Empty> {
	if (!request.taskId || !request.title?.trim()) {
		Logger.error(`[renameTask] Invalid request: taskId or title missing`)
		return Empty.create({})
	}

	try {
		await controller.renameTask(request.taskId, request.title)
		return Empty.create({})
	} catch (error) {
		Logger.error("Error in renameTask:", error)
		throw error
	}
}
