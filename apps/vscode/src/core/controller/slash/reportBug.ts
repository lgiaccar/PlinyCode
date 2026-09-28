import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/**
 * Report bug slash command logic
 */
export async function reportBug(controller: Controller, _request: StringRequest): Promise<Empty> {
	await controller.sendTaskAskResponse("yesButtonClicked")
	return Empty.create()
}
