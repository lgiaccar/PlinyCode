import { CreateHookRequest, CreateHookResponse } from "@shared/proto/cline/file"
import fs from "fs/promises"
import path from "path"
import { setHookFileToggle } from "../../hooks/hook-toggles"
import { getHookTemplate } from "../../hooks/templates"
import { isValidHookType, resolveHooksDirectory, VALID_HOOK_TYPES } from "../../hooks/utils"
import { Controller } from ".."
import { refreshHooks } from "./refreshHooks"

export async function createHook(controller: Controller, request: CreateHookRequest): Promise<CreateHookResponse> {
	const { hookName, isGlobal, workspaceName } = request

	// Validate hook name is one of the valid hook types
	if (!isValidHookType(hookName)) {
		throw new Error(`Invalid hook type: "${hookName}". Valid hook types are: ${VALID_HOOK_TYPES.join(", ")}`)
	}

	// Determine target directory
	const hooksDir = await resolveHooksDirectory(isGlobal, workspaceName)

	// Ensure directory exists
	await fs.mkdir(hooksDir, { recursive: true })

	const hookFileName = process.platform === "win32" ? `${hookName}.ps1` : hookName
	const hookPath = path.join(hooksDir, hookFileName)

	// Check if already exists
	try {
		await fs.stat(hookPath)
		throw new Error(`Hook ${hookName} already exists at ${hookPath}`)
	} catch (error) {
		// Good - file doesn't exist yet
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error
		}
	}

	await fs.writeFile(hookPath, getHookTemplate(hookName))

	// A new hook starts switched off, on every platform, so the template does
	// not run before it has been edited; the user enables it from the Hooks tab.
	setHookFileToggle(controller.stateManager, hookPath, isGlobal, false)

	// Return updated hooks state
	const hooksToggles = await refreshHooks(controller)
	return CreateHookResponse.create({ hooksToggles })
}
