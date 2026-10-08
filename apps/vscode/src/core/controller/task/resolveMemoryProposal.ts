import { Empty } from "@shared/proto/cline/common"
import type { ResolveMemoryProposalRequest } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../"

/** Save or Dismiss on a memory_proposal row (docs/memory.md). */
export async function resolveMemoryProposal(controller: Controller, request: ResolveMemoryProposalRequest): Promise<Empty> {
	if (!request.proposalId) {
		Logger.error("[resolveMemoryProposal] Invalid request: proposalId missing")
		return Empty.create({})
	}
	await controller.memory.resolveProposal(request.proposalId, request.save, request.itemIds ?? [])
	return Empty.create({})
}
