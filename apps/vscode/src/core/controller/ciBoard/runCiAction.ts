import type { RunCiActionRequest } from "@shared/proto/cline/ci_board"
import { String } from "@shared/proto/cline/common"
import type { Controller } from "../index"
import { startCiRun } from "./start-ci-run"

/**
 * Runs a CI board action on an item (or on one of its pipelines) in a new
 * conversation; returns its id, or "" when nothing started.
 */
export async function runCiAction(controller: Controller, request: RunCiActionRequest): Promise<String> {
	const conversationId = await startCiRun(controller, request.targetId, request.itemKey, {
		actionId: request.actionId,
		pipeline: request.pipeline || undefined,
	})
	return String.create({ value: conversationId ?? "" })
}
