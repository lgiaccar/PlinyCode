import { DeleteHookRequest, DeleteHookResponse } from "@shared/proto/cline/file"
import fs from "fs/promises"
import { findHookFile } from "../../hooks/hook-files"
import { clearHookFileToggle } from "../../hooks/hook-toggles"
import { resolveHookWorkspacePath } from "../../hooks/utils"
import { Controller } from ".."
import { listWindowHookFiles, refreshHooks } from "./refreshHooks"

export async function deleteHook(controller: Controller, request: DeleteHookRequest): Promise<DeleteHookResponse> {
	const { hookName, hookPath, isGlobal, workspaceName } = request
	const workspacePath = isGlobal ? undefined : await resolveHookWorkspacePath(workspaceName)
	// Only a file the engine would run can be deleted through this request.
	const hookFile = findHookFile(await listWindowHookFiles(), { hookName, hookPath, isGlobal, workspacePath })
	if (!hookFile) {
		throw new Error(`Hook ${hookPath || hookName} does not exist`)
	}

	await fs.unlink(hookFile.absolutePath)
	clearHookFileToggle(controller.stateManager, hookFile.absolutePath, isGlobal)

	return DeleteHookResponse.create({ hooksToggles: await refreshHooks(controller) })
}
