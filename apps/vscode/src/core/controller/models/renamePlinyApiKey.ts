import { PlinyApiKeyActionResult, type RenamePlinyApiKeyRequest } from "@shared/proto/cline/models"
import { plinyKeyNameProblem } from "@/hosts/vscode/pliny-api-key-check"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Gives the stored key `request.id` the nickname `request.name`; a refusal comes back as `error`. */
export async function renamePlinyApiKey(
	_controller: Controller,
	request: RenamePlinyApiKeyRequest,
): Promise<PlinyApiKeyActionResult> {
	const keys = getPlinyApiKeys()
	const entry = keys?.list().find((k) => k.id === request.id)
	if (!keys || !entry) {
		return PlinyApiKeyActionResult.create({ keys: toProtoPlinyApiKeys(keys), error: "This key is no longer stored." })
	}
	const error = plinyKeyNameProblem(keys, request.name, request.id)
	if (!error && request.name.trim() !== entry.name) {
		await keys.rename(request.id, request.name)
	}
	return PlinyApiKeyActionResult.create({ keys: toProtoPlinyApiKeys(keys), error: error ?? "" })
}
