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
	const percentage =
		usage && usage.observedMs > 0 ? Math.min(100, Math.max(0, (100 * usage.busyMs) / usage.observedMs)) : undefined
	const color =
		percentage !== undefined && percentage < 30
			? "text-error"
			: percentage !== undefined && percentage > 60
				? "text-success"
				: "text-warning"
	return (
		<div
			className="flex flex-col gap-1 text-xs text-description"
			title="Estimated busy time divided by observed online and enabled time in the last 24 hours. Red: below 30%; amber: 30–60%; green: above 60%. Sampled about once a minute. Offline, disabled, stopped and unobserved gaps are excluded. This measures agent job occupancy, not CPU usage.">
			<div>
				{stale ? "Last known: " : ""}Utilization (24h):{" "}
				{usage && percentage !== undefined ? (
					<>
						<span className={`font-semibold ${color}`}>{percentage.toFixed(1)}%</span>
						{` · ${duration(usage.busyMs)} busy / ${duration(usage.observedMs)} observed`}
					</>
				) : (
					"collecting samples…"
				)}
			</div>
			{percentage !== undefined && (
				<div
					aria-label={`${stale ? "Last known " : ""}24-hour agent utilization`}
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={percentage}
					aria-valuetext={`${percentage.toFixed(1)}% busy during observed online and enabled time`}
					className={`h-2 w-28 max-w-full overflow-hidden rounded-full border border-panel-border bg-[var(--vscode-editorWidget-background)] ${color}`}
					role="meter">
					<div className="h-full rounded-full bg-current" style={{ width: `${percentage}%` }} />
				</div>
			)}
		</div>
	)
}
