import { PlinyApiKeyTestResult, type TestPlinyApiKeyRequest } from "@shared/proto/cline/models"
import { testPlinyApiKey as sendTestRequest } from "@/hosts/vscode/pliny-api-key-check"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import type { Controller } from "../index"

/**
 * Tests a stored key (`request.id`; the key is read here and never goes back
 * to the webview) or a key typed in the add form (`request.key`) against the
 * Pliny inference server.
 */
export async function testPlinyApiKey(_controller: Controller, request: TestPlinyApiKeyRequest): Promise<PlinyApiKeyTestResult> {
	const key = request.id ? await getPlinyApiKeys()?.getKey(request.id) : request.key.trim()
	if (!key) {
		return PlinyApiKeyTestResult.create({
			ok: false,
			message: request.id ? "This key is no longer stored." : "Paste the key first.",
		})
	}
	return PlinyApiKeyTestResult.create(await sendTestRequest(key))
}
