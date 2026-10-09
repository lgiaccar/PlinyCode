import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { PLINY_FREE_AUTO_RULES_URI, PLINY_REPO_MEMORY_URI, PLINY_USER_MEMORY_URI } from "@shared/pliny"
import { Empty, StringRequest } from "@shared/proto/cline/common"
import { globalRulesPath, initialiseDefaultRulesFile } from "@/sdk/router/router-rules-store"
import { Controller } from ".."

/**
 * Opens a file in the editor
 * @param controller The controller instance
 * @param request The request message containing the file path in the 'value' field.
 *                Supports a special URI for the FreeAuto routing rules, whose path depends on the
 *                data directory the host resolved:
 *                - pliny://free-auto-rules
 *                - pliny://memory/repo and pliny://memory/user: the memory files, created when missing
 * @returns Empty response
 */
export async function openFile(controller: Controller, request: StringRequest): Promise<Empty> {
	if (request.value) {
		if (request.value === PLINY_FREE_AUTO_RULES_URI) {
			await openFreeAutoRulesFile()
		} else if (request.value === PLINY_REPO_MEMORY_URI || request.value === PLINY_USER_MEMORY_URI) {
			const { file } = await controller.ensureMemoryFile(request.value === PLINY_USER_MEMORY_URI ? "user" : "repo")
			await openFileIntegration(file)
		} else {
			await openFileIntegration(request.value)
		}
	}
	return Empty.create()
}

/**
 * Open the FreeAuto routing rules file, creating it from the documented
 * defaults when it does not exist yet. The path lives in the host's data
 * directory, so resolving it here keeps the webview free of that knowledge.
 */
async function openFreeAutoRulesFile(): Promise<void> {
	const rulesPath = (await initialiseDefaultRulesFile()) ?? globalRulesPath()
	await openFileIntegration(rulesPath)
}
