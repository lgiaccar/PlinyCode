import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import type { Controller } from "../"

export async function manageMemory(controller: Controller, request: StringRequest): Promise<StringResponse> {
	const input: unknown = JSON.parse(request.value || "{}")
	if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid memory request")
	return StringResponse.create({ value: JSON.stringify(await controller.manageMemory(input as Record<string, unknown>)) })
}
