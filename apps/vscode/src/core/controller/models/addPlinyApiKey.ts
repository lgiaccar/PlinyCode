import type { EmptyRequest } from "@shared/proto/cline/common"
import type { PlinyApiKeys } from "@shared/proto/cline/models"
import { promptAddPlinyApiKey } from "@/hosts/vscode/pliny-api-key-prompts"
import { getPlinyApiKeys } from "@/hosts/vscode/pliny-api-keys"
import type { Controller } from "../index"
import { toProtoPlinyApiKeys } from "./pliny-api-keys-proto"

/** Asks for a key's name and value in VS Code's input boxes and stores it. */
export async function addPlinyApiKey(_controller: Controller, _request: EmptyRequest): Promise<PlinyApiKeys> {
	const keys = getPlinyApiKeys()
	if (keys) {
		await promptAddPlinyApiKey(keys)
	}
	return toProtoPlinyApiKeys(keys)
}
