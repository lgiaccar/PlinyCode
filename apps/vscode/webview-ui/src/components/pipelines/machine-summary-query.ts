import type { MachineMetrics } from "@shared/grafana-metrics"
import { AgentMetricsRequest } from "@shared/proto/cline/agent_monitor"
import { AgentMonitorServiceClient } from "@/services/grpc-client"

// Limit automatic row queries; discard queued work for rows that have left the view.
let running = 0
const waiting: (() => void)[] = []
export function queryMachineSummary(host: string, range: string, active: () => boolean): Promise<MachineMetrics | undefined> {
	return new Promise((resolve, reject) => {
		const run = () => {
			if (!active()) {
				resolve(undefined)
				waiting.shift()?.()
				return
			}
			running++
			void AgentMonitorServiceClient.queryAgentMetrics(AgentMetricsRequest.create({ host, range }))
				.then((response) => resolve(JSON.parse(response.value) as MachineMetrics))
				.catch(reject)
				.finally(() => {
					running--
					waiting.shift()?.()
				})
		}
		if (running < 3) run()
		else waiting.push(run)
	})
}
