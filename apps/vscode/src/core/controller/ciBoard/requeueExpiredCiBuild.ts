import { type RequeueExpiredCiBuildRequest } from "@shared/proto/cline/ci_board"
import { Empty } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

export async function requeueExpiredCiBuild(_controller: Controller, request: RequeueExpiredCiBuildRequest): Promise<Empty> {
	const board = getCiBoard()
	if (!board) throw new Error("CI Board is unavailable.")
	await board.requeueExpiredBuildPolicy(request.targetId, request.itemKey, request.evaluationId)
	return Empty.create({})
}
