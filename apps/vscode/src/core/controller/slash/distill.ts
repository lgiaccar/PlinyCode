import { Empty, type StringRequest } from "@shared/proto/cline/common"
import type { Controller } from ".."

/**
 * `/distill`: a free utility model reads the displayed conversation and
 * proposes memories, which the user saves or dismisses from a chat row
 * (docs/memory.md). It is a side call, not a turn: the conversation's model
 * never sees it.
 */
export async function distill(controller: Controller, _request: StringRequest): Promise<Empty> {
	await controller.memory.distillNow()
	return Empty.create()
}
