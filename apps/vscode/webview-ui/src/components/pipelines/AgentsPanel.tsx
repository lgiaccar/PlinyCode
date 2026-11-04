import { DEFAULT_AGENT_MONITOR_CONFIG } from "@shared/agent-monitor"
import { AgentMonitorSettings, AgentMonitorState, type AgentMonitorsState } from "@shared/proto/cline/agent_monitor"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { DevOpsErrorText } from "@/components/common/DevOpsErrorText"
import { Button } from "@/components/ui/button"
import { AgentMonitorServiceClient, UiServiceClient } from "@/services/grpc-client"
import { AgentDiskLabel } from "./AgentDiskLabel"
import { AgentOsIcon, AgentUtilizationLabel } from "./AgentMetrics"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

export function AgentsPanel() {
	const [state, setState] = useState<AgentMonitorsState>()
	const [selected, setSelected] = useState("")
	const [adding, setAdding] = useState(false)
	const [error, setError] = useState("")
	const [connection, setConnection] = useState(0)
	// biome-ignore lint/correctness/useExhaustiveDependencies: Retry connection intentionally recreates the subscription.
	useEffect(
		() =>
			AgentMonitorServiceClient.subscribeToAgents(EmptyRequest.create({}), {
				onResponse: (response) => {
					setState(response)
					setError("")
					setSelected((current) =>
						response.pools.some((pool) => pool.id === current) ? current : (response.pools[0]?.id ?? ""),
					)
				},
				onError: (failure) => setError(pipelineError(failure)),
				onComplete: () => {},
			}),
		[connection],
	)
	const pools = state?.pools ?? []
	const saved = (id: string) => {
		setSelected(id)
		setAdding(false)
	}
	return (
		<section aria-label="Agent monitors" className="flex flex-col gap-3 min-w-0">
			<p className="text-sm text-description m-0">
				Monitor Azure DevOps agent pools. Saved for this workspace; each enabled pool refreshes every minute, even when
				this view is closed.
			</p>
			{(error || state?.error) && (
				<DevOpsErrorText
					error={error || state?.error || ""}
					onSignedIn={async () => setConnection((value) => value + 1)}
				/>
			)}
			{error && state && !state.error && (
				<Button onClick={() => setConnection((value) => value + 1)}>Retry connection</Button>
			)}
			{!state || state.error ? (
				error || state?.error ? (
					<Button onClick={() => setConnection((value) => value + 1)}>Retry connection</Button>
				) : (
					<p>Loading agent monitors...</p>
				)
			) : (
				<>
					<div className="flex flex-wrap items-end gap-2">
						{pools.length > 0 && (
							<label className="text-sm flex flex-col gap-1 flex-1 min-w-0">
								Agent pool
								<select
									className={fieldClass}
									onChange={(event) => {
										setSelected(event.target.value)
										setAdding(false)
									}}
									value={adding ? "" : selected}>
									{adding && <option value="">New pool</option>}
									{pools.map((pool, index) => (
										<option key={pool.id} value={pool.id}>
											{pool.poolName || `Pool ${index + 1}`} -{" "}
											{pool.error ? "Connection error" : pool.config?.enabled ? "Monitoring" : "Stopped"}
										</option>
									))}
								</select>
							</label>
						)}
						<Button
							disabled={adding || pools.length === 0}
							onClick={() => setAdding(true)}
							size="sm"
							variant="secondary">
							Add pool
						</Button>
					</div>
					{pools.map((pool) => (
						<AgentPoolPanel
							connectionError={error}
							hidden={adding || pool.id !== selected}
							key={pool.id}
							onSaved={saved}
							state={pool}
						/>
					))}
					{(adding || pools.length === 0) && (
						<>
							<AgentPoolPanel
								key="new"
								onSaved={saved}
								state={AgentMonitorState.create({
									config: {
										...DEFAULT_AGENT_MONITOR_CONFIG,
										authentication: state.defaultAuthentication || pools[0]?.config?.authentication || "pat",
									},
								})}
							/>
							{pools.length > 0 && (
								<Button onClick={() => setAdding(false)} variant="secondary">
									Cancel adding pool
								</Button>
							)}
						</>
					)}
				</>
			)}
		</section>
	)
}

function AgentPoolPanel({
	state,
	hidden = false,
	onSaved,
	connectionError = "",
}: {
	state: AgentMonitorState
	hidden?: boolean
	onSaved: (id: string) => void
	connectionError?: string
}) {
	const [draft, setDraft] = useState(state.config)
	const [filters, setFilters] = useState(state.config?.capabilities.join(", ") ?? "")
	const [error, setError] = useState("")
	const [saving, setSaving] = useState(false)
	const [search, setSearch] = useState("")
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		if (!state.config?.diskMetricsFolder) return
		const timer = setInterval(() => setNow(Date.now()), 30_000)
		return () => clearInterval(timer)
	}, [state.config?.diskMetricsFolder])
	const refresh = async () => {
		setError("")
		try {
			await AgentMonitorServiceClient.refreshAgentMonitor(StringRequest.create({ value: state.id }))
		} catch (failure) {
			setError(pipelineError(failure))
		}
	}
	const save = async (enabled: boolean) => {
		if (!draft) return
		setSaving(true)
		setError("")
		try {
			const response = await AgentMonitorServiceClient.configureAgentMonitor(
				AgentMonitorSettings.create({
					...draft,
					id: state.id,
					enabled,
					capabilities: filters
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
				}),
			)
			onSaved(response.value)
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			setSaving(false)
		}
	}
	const open = (url: string) =>
		void UiServiceClient.openUrl(StringRequest.create({ value: url })).catch((failure) => setError(pipelineError(failure)))
	const stale = Boolean(error || connectionError || state?.error || !state?.config?.enabled)
	const agents = state?.agents ?? []
	const visible = agents.filter((agent) =>
		`${agent.name} ${agent.pipelineName} ${agent.runName} ${agent.jobName} ${agent.capabilities.join(" ")}`
			.toLowerCase()
			.includes(search.toLowerCase()),
	)
	return (
		<section
			aria-label={state.poolName || "Agent monitor"}
			className={hidden ? "hidden" : "flex flex-col gap-3 min-w-0"}
			hidden={hidden}>
			{draft ? (
				<>
					<label className="text-sm flex flex-col gap-1">
						Agent-pool URL
						<input
							aria-describedby={`agent-pool-url-help-${state.id || "new"}`}
							className={fieldClass}
							onChange={(event) => setDraft({ ...draft, queueUrl: event.target.value })}
							placeholder="Paste your Azure DevOps agent-pool URL"
							value={draft.queueUrl}
						/>
					</label>
					<p className="text-xs text-description m-0" id={`agent-pool-url-help-${state.id || "new"}`}>
						{draft.queueUrl.trim()
							? "Use the address from Project settings → Agent pools, including queueId. Starting or saving reuses this URL as your local default for new workspaces."
							: "Paste your agent-pool URL to enable Start monitoring. Copy it from Project settings → Agent pools."}
					</p>
					<label className="text-sm flex flex-col gap-1">
						Authentication
						<select
							className={fieldClass}
							onChange={(event) => setDraft({ ...draft, authentication: event.target.value })}
							value={draft.authentication}>
							<option value="windows">Windows sign-in (local Windows host)</option>
							<option value="pat">Personal access token / existing DevOps sign-in</option>
						</select>
					</label>
					<label className="text-sm flex flex-col gap-1">
						Capability filters
						<input className={fieldClass} onChange={(event) => setFilters(event.target.value)} value={filters} />
					</label>
					<p className="text-xs text-description m-0">
						Comma-separated names or prefixes ending in *. Matches any filter. Leave empty for all agents. Names are
						case-sensitive.
					</p>
					<details className="text-sm">
						<summary className="cursor-pointer">Disk space (optional)</summary>
						<div className="flex flex-col gap-2 mt-2">
							<label className="flex flex-col gap-1">
								Disk metrics folder
								<input
									className={fieldClass}
									onChange={(event) => setDraft({ ...draft, diskMetricsFolder: event.target.value })}
									placeholder="Shared folder accessible from this editor"
									value={draft.diskMetricsFolder}
								/>
							</label>
							<p className="text-xs text-description m-0">
								Run the collector on each agent and point it at this shared folder. Leave empty to turn off disk
								monitoring.
							</p>
							<button
								className="text-left text-link text-xs"
								onClick={() =>
									open("https://github.com/lgiaccar/PlinyCode/blob/stage/docs/agent-disk-monitor.md")
								}
								type="button">
								Collector setup instructions
							</button>
							<div className="flex flex-wrap gap-2">
								<label className="flex flex-col gap-1">
									Warn below (% free)
									<input
										className={`${fieldClass} w-24`}
										max={90}
										min={2}
										onChange={(event) =>
											setDraft({ ...draft, diskWarningPercent: Number(event.target.value) })
										}
										type="number"
										value={draft.diskWarningPercent || 20}
									/>
								</label>
								<label className="flex flex-col gap-1">
									Critical below (% free)
									<input
										className={`${fieldClass} w-24`}
										max={89}
										min={1}
										onChange={(event) =>
											setDraft({ ...draft, diskCriticalPercent: Number(event.target.value) })
										}
										type="number"
										value={draft.diskCriticalPercent || 10}
									/>
								</label>
							</div>
							<label className="flex gap-2 items-center">
								<input
									checked={draft.diskNotify}
									onChange={(event) => setDraft({ ...draft, diskNotify: event.target.checked })}
									type="checkbox"
								/>
								Notify when free space crosses the warning threshold
							</label>
						</div>
					</details>
					<label className="text-sm flex gap-2 items-center">
						<input
							checked={draft.notify}
							onChange={(event) => setDraft({ ...draft, notify: event.target.checked })}
							type="checkbox"
						/>
						Notify when an agent goes online/offline or is enabled/disabled
					</label>
					<div className="flex flex-wrap gap-2">
						<Button disabled={saving || !draft.queueUrl.trim()} onClick={() => void save(true)} size="sm">
							{state?.config?.enabled ? "Save monitor" : "Start monitoring"}
						</Button>
						{!state.config?.enabled && (
							<Button
								disabled={saving || !draft.queueUrl.trim()}
								onClick={() => void save(false)}
								size="sm"
								variant="secondary">
								Save pool
							</Button>
						)}
						{state?.config?.enabled && (
							<Button
								disabled={saving}
								onClick={() => {
									setSaving(true)
									void AgentMonitorServiceClient.configureAgentMonitor(
										AgentMonitorSettings.create({ ...state.config, id: state.id, enabled: false }),
									)
										.catch((failure) => setError(pipelineError(failure)))
										.finally(() => setSaving(false))
								}}
								size="sm"
								variant="secondary">
								Stop monitoring
							</Button>
						)}
						<Button
							disabled={state?.refreshing || !state?.config?.enabled}
							onClick={() => void refresh()}
							size="sm"
							variant="secondary">
							{state?.refreshing ? "Refreshing…" : "Refresh"}
						</Button>
						{state.id && (
							<Button
								disabled={saving}
								onClick={() => {
									setSaving(true)
									void AgentMonitorServiceClient.removeAgentMonitor(StringRequest.create({ value: state.id }))
										.catch((failure) => setError(pipelineError(failure)))
										.finally(() => setSaving(false))
								}}
								size="sm"
								variant="secondary">
								Remove pool
							</Button>
						)}
					</div>
				</>
			) : !state?.error && !error ? (
				<p>Loading agent monitor…</p>
			) : (
				<Button onClick={() => void refresh()}>Retry connection</Button>
			)}
			{(error || state?.error) && (
				<DevOpsErrorText
					className="text-sm text-error break-words"
					error={error || state?.error || ""}
					onSignedIn={refresh}
				/>
			)}
			{state?.poolName && <h2 className="text-sm font-medium m-0">{state.poolName}</h2>}
			<div className="text-sm" role="status">
				{state?.updated ? (
					<>
						{stale ? "Status unknown — showing last known values. " : ""}
						{agents.filter((agent) => agent.status === "online").length} online ·{" "}
						{agents.filter((agent) => agent.status === "offline").length} offline ·{" "}
						{agents.filter((agent) => agent.status === "unknown").length} unknown ·{" "}
						{agents.filter((agent) => !agent.enabled).length} disabled
						<div className="text-xs text-description">
							{agents.length} of {state.total} agents match. Last successful refresh:{" "}
							{new Date(state.updated).toLocaleString()}.
						</div>
					</>
				) : state?.config?.enabled ? (
					"Waiting for the first successful refresh."
				) : (
					"Monitoring stopped."
				)}
			</div>
			{agents.length > 0 && (
				<label className="text-sm flex flex-col gap-1">
					Search agents or pipelines
					<input className={fieldClass} onChange={(event) => setSearch(event.target.value)} value={search} />
				</label>
			)}
			{Boolean(state?.updated) && visible.length === 0 && (
				<p className="text-sm text-description">No agents match these filters.</p>
			)}
			<ul className="list-none m-0 p-0">
				{visible.map((agent) => (
					<li className="border-b border-panel-border py-3 flex flex-col gap-1 min-w-0" key={agent.id}>
						<button className="text-left text-link break-all" onClick={() => open(agent.url)} type="button">
							<AgentOsIcon os={agent.os} />
							{agent.name}
						</button>
						<div
							className={`text-sm ${stale ? "text-description" : agent.status === "offline" ? "text-error" : agent.status === "online" ? "text-success" : "text-warning"}`}>
							{stale ? "Last known: " : ""}
							{agent.status} · {agent.enabled ? "Enabled" : "Disabled"} ·{" "}
							{agent.status !== "online" ? "Job status unknown" : agent.busy ? "Busy" : "Idle"}
						</div>
						<div className="text-xs text-description break-words">
							{agent.capabilities.join(", ") || "No capabilities reported"}
						</div>
						<AgentUtilizationLabel agent={agent} stale={stale} />
						{state.config?.diskMetricsFolder && (
							<AgentDiskLabel
								agent={agent}
								critical={state.config.diskCriticalPercent || 10}
								now={now}
								stale={stale}
								warning={state.config.diskWarningPercent || 20}
							/>
						)}
						{agent.busy &&
							agent.status === "online" &&
							(agent.jobUrl ? (
								<button
									className="text-left text-link text-xs break-words"
									onClick={() => open(agent.jobUrl)}
									type="button">
									{agent.pipelineName || "Pipeline name unavailable"}
								</button>
							) : (
								<span className="text-xs break-words">{agent.pipelineName || "Pipeline name unavailable"}</span>
							))}
						{agent.busy && agent.status === "online" && (agent.runName || agent.jobName) && (
							<div className="text-xs text-description break-words">
								{[agent.runName && `Run: ${agent.runName}`, agent.jobName && `Job: ${agent.jobName}`]
									.filter(Boolean)
									.join(" · ")}
							</div>
						)}
					</li>
				))}
			</ul>
		</section>
	)
}
