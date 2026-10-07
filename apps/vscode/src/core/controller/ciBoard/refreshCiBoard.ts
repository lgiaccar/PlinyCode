import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

/** Fetches one CI board target (by id), or all of them for an empty id, now. */
export async function refreshCiBoard(_controller: Controller, request: StringRequest): Promise<Empty> {
	const board = getCiBoard()
	if (board) {
		await board.rescanCheckouts()
		await board.refresh(request.value || undefined)
	}
	return Empty.create({})
}
