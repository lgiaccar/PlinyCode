import { ImprovePromptRequest, ImprovePromptResult } from "@shared/proto/cline/task"
import { toMode } from "@shared/storage/types"
import { Controller } from ".."

/** Rewrites the draft prompt in the chat box; a failure comes back as `error`, never as a thrown error. */
export async function improvePrompt(controller: Controller, request: ImprovePromptRequest): Promise<ImprovePromptResult> {
	const result = await controller.improvePrompt(request.text, toMode(request.mode))
	return ImprovePromptResult.create({ text: result.text ?? "", error: result.error ?? "" })
}
