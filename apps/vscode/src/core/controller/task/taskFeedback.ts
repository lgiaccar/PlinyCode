import { Empty, StringRequest } from "@shared/proto/cline/common"
import { Controller } from ".."

/**
 * Handles task feedback (thumbs up/down). Feedback only went to telemetry,
 * which PlinyCode doesn't send, so there is nothing to record.
 */
export async function taskFeedback(_controller: Controller, _request: StringRequest): Promise<Empty> {
	return Empty.create()
}
