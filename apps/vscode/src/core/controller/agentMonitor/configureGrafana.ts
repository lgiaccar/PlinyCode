import { type StringRequest, String as StringResponse } from "@shared/proto/cline/common"
import { configureGrafanaMetrics } from "@/hosts/vscode/grafana-metrics"
import type { Controller } from "../index"

export async function configureGrafana(_controller: Controller, request: StringRequest): Promise<StringResponse> {
	return StringResponse.create({ value: JSON.stringify(await configureGrafanaMetrics(JSON.parse(request.value))) })
}
