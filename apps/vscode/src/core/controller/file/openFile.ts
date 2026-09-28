import { openFile as openFileIntegration } from "@integrations/misc/open-file"
import { PLINY_FREE_AUTO_RULES_URI } from "@shared/pliny"
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
 * @returns Empty response
 */
export async function openFile(_controller: Controller, request: StringRequest): Promise<Empty> {
	if (request.value) {
		if (request.value === PLINY_FREE_AUTO_RULES_URI) {
			await openFreeAutoRulesFile()
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
