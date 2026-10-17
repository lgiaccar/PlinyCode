import { ToggleHookRequest, ToggleHookResponse } from "@shared/proto/cline/file"
import { findHookFile } from "../../hooks/hook-files"
import { setHookFileToggle } from "../../hooks/hook-toggles"
import { resolveHookWorkspacePath } from "../../hooks/utils"
import { Controller } from ".."
import { listWindowHookFiles, toHooksToggles } from "./refreshHooks"

/**
 * Switches one hook file on or off. The choice is recorded in the hook toggle
 * state (global setting or workspace state), which the engine's hook filter
 * reads before every hook run, so it works on every platform and applies to
 * live sessions. The file itself is left alone.
 */
export async function toggleHook(controller: Controller, request: ToggleHookRequest): Promise<ToggleHookResponse> {
	const { hookName, hookPath, isGlobal, enabled, workspaceName } = request
	const listing = await listWindowHookFiles()
	const workspacePath = isGlobal ? undefined : await resolveHookWorkspacePath(workspaceName)
	const hookFile = findHookFile(listing, { hookName, hookPath, isGlobal, workspacePath })
	if (!hookFile) {
		throw new Error(`Hook ${hookPath || hookName} does not exist`)
	}

	setHookFileToggle(controller.stateManager, hookFile.absolutePath, isGlobal, enabled)

	return ToggleHookResponse.create({ hooksToggles: toHooksToggles(controller.stateManager, listing) })
}
