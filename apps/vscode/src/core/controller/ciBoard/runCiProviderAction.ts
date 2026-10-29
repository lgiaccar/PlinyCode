import type { CiProviderActionRequest } from "@shared/proto/cline/ci_board"
import { Empty } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

export async function runCiProviderAction(_controller: Controller, request: CiProviderActionRequest): Promise<Empty> {
	const board = getCiBoard()
	if (!board) throw new Error("CI Board is unavailable.")
	await board.runProviderAction(request.targetId, request.itemKey, request.action, request.evaluationId)
	return Empty.create({})
}
