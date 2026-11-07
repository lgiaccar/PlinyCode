import type { AgentMetricsRequest } from "@shared/proto/cline/agent_monitor"
import { String as StringResponse } from "@shared/proto/cline/common"
import { readGrafanaMetrics } from "@/hosts/vscode/grafana-metrics"
import type { Controller } from "../index"

export async function queryAgentMetrics(_controller: Controller, request: AgentMetricsRequest): Promise<StringResponse> {
	return StringResponse.create({
		value: JSON.stringify(await readGrafanaMetrics(request.host, request.range, request.diskOnly)),
	})
}
