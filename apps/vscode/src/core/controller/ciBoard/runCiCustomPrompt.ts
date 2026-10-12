import type { RunCiCustomPromptRequest } from "@shared/proto/cline/ci_board"
import { String } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiAction, CiPromptSource } from "@/services/devops-mcp/ci-board/types"
import type { Controller } from "../index"
import { startCiRun } from "./start-ci-run"

/**
 * Runs a prompt typed or picked for one item, like an action, and saves it as
 * an action of the target when `saveAs` is set. Returns the conversation id,
 * or "" when nothing started.
 */
export async function runCiCustomPrompt(controller: Controller, request: RunCiCustomPromptRequest): Promise<String> {
	const board = getCiBoard()
	if (!board) {
		throw new Error("The CI board is not available.")
	}
	const value = request.promptValue.trim()
	if (!value) {
		throw new Error(request.promptKind === "file" ? "Pick a prompt file." : "Write a prompt first.")
	}
	const prompt: CiPromptSource =
		request.promptKind === "file" ? { kind: "file", path: value } : { kind: "text", text: request.promptValue }
	const model = request.model === "current" ? "current" : "free"
	const label = request.saveAs.trim()
	if (label) {
		const target = board.target(request.targetId)
		if (!target) {
			throw new Error("That CI board entry no longer exists.")
		}
		const action: CiAction = { id: `custom-${Date.now().toString(36)}`, label, prompt, model, situation: "any", auto: false }
		await board.updateTarget(target.id, { actions: [...target.actions, action] })
	}
	const conversationId = await startCiRun(controller, request.targetId, request.itemKey, {
		custom: prompt,
		label: label || "Custom prompt",
		model,
	})
	return String.create({ value: conversationId ?? "" })
}
