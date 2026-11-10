import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import { manageSettingsCatalog as manage } from "@/hosts/vscode/settings-catalog"
import type { Controller } from ".."

export async function manageSettingsCatalog(_controller: Controller, request: StringRequest): Promise<StringResponse> {
	const input = JSON.parse(request.value || "{}")
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid settings request")
	return StringResponse.create({ value: JSON.stringify(await manage(input)) })
}
