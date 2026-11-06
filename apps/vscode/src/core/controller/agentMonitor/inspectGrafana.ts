import { type EmptyRequest, String as StringResponse } from "@shared/proto/cline/common"
import { inspectGrafanaDashboard } from "@/hosts/vscode/grafana-metrics"
import type { Controller } from "../index"

export async function inspectGrafana(_controller: Controller, _request: EmptyRequest): Promise<StringResponse> {
	return StringResponse.create({ value: JSON.stringify(await inspectGrafanaDashboard()) })
}
