import type { StringRequest } from "@shared/proto/cline/common"
import type { PlinyApiKeys } from "@shared/proto/cline/models"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Forgets the stored key whose id is `request.value`. */
export async function removePlinyApiKey(_controller: Controller, request: StringRequest): Promise<PlinyApiKeys> {
	const keys = getPlinyApiKeys()
	if (keys && request.value) {
		await keys.remove(request.value)
	}
	return toProtoPlinyApiKeys(keys)
}
