import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import { inspectContextRequests } from "@/sdk/context-inspector"
import type { Controller } from ".."

export async function inspectContext(controller: Controller, request: StringRequest): Promise<StringResponse> {
	const id = request.value || controller.task?.taskId
	if (!id || (id !== controller.task?.taskId && !(await controller.getHistoryItem(id))))
		throw new Error("Conversation not found")
	return StringResponse.create({ value: JSON.stringify(inspectContextRequests(id)) })
}
