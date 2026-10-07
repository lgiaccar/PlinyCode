import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"
import { sendChatButtonClickedEvent } from "../ui/subscribeToChatButtonClicked"

/** Opens the conversation a CI board action last started for an item (by item key). */
export async function openCiConversation(controller: Controller, request: StringRequest): Promise<Empty> {
	const link = getCiBoard()?.linkFor(request.value)
	if (!link) {
		throw new Error("No conversation was started for this item.")
	}
	await controller.showTaskWithId(link.conversationId)
	await sendChatButtonClickedEvent()
	return Empty.create({})
}
