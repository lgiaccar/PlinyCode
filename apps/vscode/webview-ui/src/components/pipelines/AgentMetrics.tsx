import type { MonitoredAgentInfo } from "@shared/proto/cline/agent_monitor"

export function AgentOsIcon({ os }: { os: string }) {
	const name = os === "windows" ? "Windows" : os === "linux" ? "Linux" : os === "macos" ? "macOS" : "Unknown OS"
	return (
		<span aria-label={name} className="inline-flex items-center mr-1.5 shrink-0" role="img" title={name}>
			{os === "windows" ? (
				<svg aria-hidden="true" fill="currentColor" height="14" viewBox="0 0 16 16" width="14">
					<path d="M1 2.5 7 1.7v5.8H1zm7-1L15 .5v7H8zM1 8.5h6v5.8l-6-.8zm7 0h7v7l-7-1z" />
				</svg>
			) : os === "linux" ? (
				"🐧"
			) : os === "macos" ? (
				"🍎"
			) : (
				"?"
			)}
		</span>
	)
}

function duration(ms: number): string {
	if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
	if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
	return `${(ms / 3_600_000).toFixed(1)}h`
}

export function AgentUtilizationLabel({ agent, stale }: { agent: MonitoredAgentInfo; stale: boolean }) {
	const usage = agent.utilization
	return (
		<div
			className="text-xs text-description"
			title="Estimated busy time divided by observed online and enabled time in the last 24 hours. Sampled about once a minute. Offline, disabled, stopped and unobserved gaps are excluded. This measures agent job occupancy, not CPU usage.">
			{stale ? "Last known: " : ""}Utilization (24h):{" "}
			{usage && usage.observedMs > 0
				? `${((100 * usage.busyMs) / usage.observedMs).toFixed(1)}% · ${duration(usage.busyMs)} busy / ${duration(usage.observedMs)} observed`
				: "collecting samples…"}
		</div>
	)
}
