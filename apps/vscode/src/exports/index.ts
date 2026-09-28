import { Controller } from "@core/controller"
import { sendChatButtonClickedEvent } from "@core/controller/ui/subscribeToChatButtonClicked"
import { Logger } from "@/shared/services/Logger"
import { ClineAPI } from "./cline"

export function createClineAPI(sidebarController: Controller): ClineAPI {
	const api: ClineAPI = {
		startNewTask: async (task?: string, images?: string[]) => {
			await sidebarController.clearTask({ detachRunning: true })
			await sidebarController.postStateToWebview()

			await sendChatButtonClickedEvent()
			await sidebarController.initTask(task, images)
		},

		sendMessage: async (message?: string, images?: string[]) => {
			if (!(await sidebarController.sendTaskAskResponse("messageResponse", message || "", images || []))) {
				Logger.error("No active task to send message to")
			}
		},

		pressPrimaryButton: async () => {
			if (!(await sidebarController.sendTaskAskResponse("yesButtonClicked", "", []))) {
				Logger.error("No active task to press button for")
			}
		},

		pressSecondaryButton: async () => {
			if (!(await sidebarController.sendTaskAskResponse("noButtonClicked", "", []))) {
				Logger.error("No active task to press button for")
			}
		},
	}

	return api
}
