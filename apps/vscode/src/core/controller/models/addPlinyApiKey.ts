import { type AddPlinyApiKeyRequest, PlinyApiKeyActionResult } from "@shared/proto/cline/models"
import { plinyNewKeyProblem } from "@/hosts/vscode/pliny-api-key-check"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Checks a key typed in Settings and stores it under its nickname; a refusal comes back as `error`. */
export async function addPlinyApiKey(_controller: Controller, request: AddPlinyApiKeyRequest): Promise<PlinyApiKeyActionResult> {
	const keys = getPlinyApiKeys()
	if (!keys) {
		return PlinyApiKeyActionResult.create({ keys: toProtoPlinyApiKeys(keys), error: "The key store is not ready yet." })
	}
	const error = await plinyNewKeyProblem(keys, request.name, request.key)
	if (!error) {
		const name = request.name.trim()
		await keys.add(name, request.key.trim())
		Logger.log(`[PlinyApiKeys] Stored a Pliny API key named "${name}"`)
	}
	return PlinyApiKeyActionResult.create({ keys: toProtoPlinyApiKeys(keys), error: error ?? "" })
}
