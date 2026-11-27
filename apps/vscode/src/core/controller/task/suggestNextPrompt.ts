import { type SuggestNextPromptRequest, SuggestNextPromptResult } from "@shared/proto/cline/task"
import type { Controller } from ".."
export async function suggestNextPrompt(
	controller: Controller,
	request: SuggestNextPromptRequest,
): Promise<SuggestNextPromptResult> {
	return SuggestNextPromptResult.create(await controller.suggestNextPrompt(request.taskId, request.completionTs, request.force))
}
