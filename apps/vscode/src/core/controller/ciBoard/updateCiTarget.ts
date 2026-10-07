import type { UpdateCiTargetRequest } from "@shared/proto/cline/ci_board"
import { Empty } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiTargetPatch } from "@/services/devops-mcp/ci-board/ci-board"
import type { Controller } from "../index"
import { fromProtoAction } from "./ci-board-view"

const AUTONOMY = ["manual", "auto", "full_auto"] as const

/** Changes a CI board target's autonomy, actions or PR filter. */
export async function updateCiTarget(_controller: Controller, request: UpdateCiTargetRequest): Promise<Empty> {
	const board = getCiBoard()
	if (!board) {
		throw new Error("The CI board is not available.")
	}
	const patch: CiTargetPatch = {}
	if (request.autonomy !== undefined) {
		const autonomy = AUTONOMY.find((a) => a === request.autonomy)
		if (!autonomy) {
			throw new Error(`Unknown autonomy "${request.autonomy}".`)
		}
		patch.autonomy = autonomy
	}
	if (request.setActions) {
		const actions = request.actions.map(fromProtoAction)
		if (actions.some((a) => !a.id) || new Set(actions.map((a) => a.id)).size !== actions.length) {
			throw new Error("Every action needs its own id.")
		}
		const empty = actions.find(
			(a) => (a.prompt.kind === "file" && !a.prompt.path) || (a.prompt.kind === "text" && !a.prompt.text.trim()),
		)
		if (empty) {
			throw new Error(`The prompt of "${empty.label}" is empty.`)
		}
		patch.actions = actions
	}
	if (request.prFilter !== undefined) {
		patch.prFilter = request.prFilter === "all" ? "all" : "mine"
	}
	await board.updateTarget(request.id, patch)
	return Empty.create({})
}
