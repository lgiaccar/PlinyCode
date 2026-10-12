import type { CiItemRequest } from "@shared/proto/cline/ci_board"
import { Empty } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

/** Analyses an item's failures again; the result reaches the view with the board. */
export async function analyzeCiItem(_controller: Controller, request: CiItemRequest): Promise<Empty> {
	const board = getCiBoard()
	if (!board) {
		throw new Error("The CI board is not available.")
	}
	await board.analyze(request.targetId, request.itemKey)
	return Empty.create({})
}
