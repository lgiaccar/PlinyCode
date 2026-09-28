import { Empty } from "@shared/proto/cline/common"
import { TrackWorktreeViewOpenedRequest } from "@shared/proto/cline/worktree"
import { Controller } from ".."

/**
 * Records that the worktrees view was opened. Only telemetry used it, which
 * PlinyCode doesn't send, so there is nothing to record.
 */
export async function trackWorktreeViewOpened(_controller: Controller, _request: TrackWorktreeViewOpenedRequest): Promise<Empty> {
	return Empty.create({})
}
