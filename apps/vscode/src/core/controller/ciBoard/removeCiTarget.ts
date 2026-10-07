import { Empty, type StringRequest } from "@shared/proto/cline/common"
import { getCiBoard } from "@/services/devops-mcp/builtin-mcp-registry"
import type { Controller } from "../index"

/** Removes a target from the CI board. Its worktrees and conversations stay. */
export async function removeCiTarget(_controller: Controller, request: StringRequest): Promise<Empty> {
	await getCiBoard()?.removeTarget(request.value)
	return Empty.create({})
}
