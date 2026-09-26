import { workspaceResolver } from "@core/workspace"
import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { getWorkspacePath } from "@utils/path"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Opens a file in the editor by a relative path
 * @param controller The controller instance
 * @param request The request message containing the relative file path in the 'value' field
 * @returns Empty response
 */
export async function openFileRelativePath(_controller: Controller, request: StringRequest): Promise<Empty> {
	// Absolute paths open as-is, even when no workspace folder is open.
	if (request.value && path.isAbsolute(request.value)) {
		openFileIntegration(request.value)
		return Empty.create()
	}

	const workspacePath = await getWorkspacePath()

	if (!workspacePath) {
		Logger.error("Error in openFileRelativePath: No workspace path available")
		return Empty.create()
	}

	if (request.value) {
		// Resolve the relative path to absolute path
		const resolvedPath = workspaceResolver.resolveWorkspacePath(
			workspacePath,
			request.value,
			"Controller.openFileRelativePath",
		)
		const absolutePath = typeof resolvedPath === "string" ? resolvedPath : resolvedPath.absolutePath

		// Open the file using the existing integration
		openFileIntegration(absolutePath)
	}

	return Empty.create()
}
