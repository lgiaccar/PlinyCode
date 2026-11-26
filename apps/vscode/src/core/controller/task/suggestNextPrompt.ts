import { String as StringMessage } from "@shared/proto/cline/common"
import type { SuggestNextPromptRequest } from "@shared/proto/cline/task"
import type { Controller } from ".."
export async function suggestNextPrompt(controller: Controller, request: SuggestNextPromptRequest): Promise<StringMessage> {
	return StringMessage.create({ value: await controller.suggestNextPrompt(request.taskId, request.completionTs) })
}
