import type { StringRequest } from "@shared/proto/cline/common"
import type { PlinyApiKeys } from "@shared/proto/cline/models"
import { promptRenamePlinyApiKey } from "@/hosts/vscode/pliny-api-key-prompts"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Asks for a new name for the stored key whose id is `request.value`. */
export async function renamePlinyApiKey(_controller: Controller, request: StringRequest): Promise<PlinyApiKeys> {
	const keys = getPlinyApiKeys()
	if (keys && request.value) {
		await promptRenamePlinyApiKey(keys, request.value)
	}
	return toProtoPlinyApiKeys(keys)
}
