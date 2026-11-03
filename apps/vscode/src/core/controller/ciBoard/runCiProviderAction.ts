import type { CiProviderActionRequest } from "@shared/proto/cline/ci_board"
import { Empty } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

export async function runCiProviderAction(controller: Controller, request: CiProviderActionRequest): Promise<Empty> {
	const board = getCiBoard()
	if (!board) throw new Error("CI Board is unavailable.")
	if (request.action === "merge-pr") {
		const link = board.linkFor(request.itemKey)
		const activity = link && controller.conversationActivity(link.conversationId)
		if (activity === "running" || activity === "background")
			throw new Error("Wait for the board's running conversation to finish before merging.")
	}
	await board.runProviderAction(
		request.targetId,
		request.itemKey,
		request.action,
		request.evaluationId,
		request.runId,
		request.expectedHeadSha,
		request.expectedTargetBranch,
	)
	return Empty.create({})
}
