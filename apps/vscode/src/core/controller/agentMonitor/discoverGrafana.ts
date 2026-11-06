import { String as StringResponse } from "@shared/proto/cline/common"
import { discoverGrafanaMetrics } from "@/hosts/vscode/grafana-metrics"
import type { Controller } from "../index"

export async function discoverGrafana(_controller: Controller): Promise<StringResponse> {
	return StringResponse.create({ value: JSON.stringify(await discoverGrafanaMetrics()) })
}
