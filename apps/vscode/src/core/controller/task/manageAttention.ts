import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import type { Controller } from ".."

export async function manageAttention(controller: Controller, request: StringRequest): Promise<StringResponse> {
	const input = JSON.parse(request.value || "{}")
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid attention request")
	return StringResponse.create({ value: JSON.stringify(await controller.manageAttention(input)) })
}
