import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import type { Controller } from ".."

export async function getDeliveryEvidence(controller: Controller, request: StringRequest): Promise<StringResponse> {
	return StringResponse.create({ value: JSON.stringify(await controller.getDeliveryEvidence(request.value)) })
}
