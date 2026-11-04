import { freshAgentDisk } from "@shared/agent-monitor"
import type { MonitoredAgentInfo } from "@shared/proto/cline/agent_monitor"

export function AgentDiskLabel({
	agent,
	stale,
	now,
	warning,
	critical,
}: {
	agent: MonitoredAgentInfo
	stale: boolean
	now: number
	warning: number
	critical: number
}) {
	const disk = agent.disk
	if (!disk)
		return (
			<div className="text-xs text-description" title={agent.diskError}>
				Work disk: awaiting collector data
			</div>
		)
	const lastKnown = stale || !freshAgentDisk(agent, now)
	const free = (100 * disk.freeBytes) / disk.totalBytes
	const color = lastKnown
		? "text-description"
		: free < critical
			? "text-error"
			: free < warning
				? "text-warning"
				: "text-success"
	const age = Math.max(0, Math.floor((now - disk.collectedAt) / 60_000))
	const updated = age < 1 ? "just now" : age < 60 ? `${age}m ago` : `${(age / 60).toFixed(1)}h ago`
	return (
		<div
			className="flex flex-col gap-1 text-xs text-description"
			title={`Working directory: ${disk.path}\nCollected: ${new Date(disk.collectedAt).toLocaleString()}${agent.diskError ? `\n${agent.diskError}` : ""}`}>
			<div>
				{lastKnown ? "Last known work disk: " : "Work disk: "}
				<span className={`font-semibold ${color}`}>{(disk.freeBytes / 1073741824).toFixed(1)} GiB free</span>
				{` / ${(disk.totalBytes / 1073741824).toFixed(1)} GiB · ${free.toFixed(1)}% free`}
			</div>
			<div
				aria-label={`${lastKnown ? "Last known " : ""}work disk free space`}
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={free}
				aria-valuetext={`${free.toFixed(1)}% free${lastKnown ? ", last known reading" : ""}`}
				className={`h-2 w-28 max-w-full overflow-hidden rounded-full border border-panel-border bg-[var(--vscode-editorWidget-background)] ${color}`}
				role="meter">
				<div className="h-full rounded-full bg-current" style={{ width: `${free}%` }} />
			</div>
			<div>
				Updated {updated}
				{lastKnown ? " · reading unavailable or stale" : ""}
			</div>
		</div>
	)
}
