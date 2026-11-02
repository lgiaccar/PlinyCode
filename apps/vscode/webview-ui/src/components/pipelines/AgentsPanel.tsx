import { AgentMonitorSettings, type AgentMonitorState } from "@shared/proto/cline/agent_monitor"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useEffect, useRef, useState } from "react"
import { DevOpsErrorText } from "@/components/common/DevOpsErrorText"
import { Button } from "@/components/ui/button"
import { AgentMonitorServiceClient, UiServiceClient } from "@/services/grpc-client"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

export function AgentsPanel() {
	const [state, setState] = useState<AgentMonitorState>()
	const [draft, setDraft] = useState<AgentMonitorSettings>()
	const [filters, setFilters] = useState("")
	const [error, setError] = useState("")
	const [saving, setSaving] = useState(false)
	const [connection, setConnection] = useState(0)
	const [search, setSearch] = useState("")
	const initialized = useRef(false)
	useEffect(
		() =>
			AgentMonitorServiceClient.subscribeToAgents(EmptyRequest.create({}), {
				onResponse: (response) => {
					setState(response)
					setError("")
					if (!initialized.current && response.config) {
						initialized.current = true
						setDraft(response.config)
						setFilters(response.config.capabilities.join(", "))
					}
				},
				onError: (failure) => setError(pipelineError(failure)),
				onComplete: () => {},
			}),
		[connection],
	)
	const refresh = async () => {
		setConnection((value) => value + 1)
		try {
			await AgentMonitorServiceClient.refreshAgentMonitor(EmptyRequest.create({}))
		} catch (failure) {
			setError(pipelineError(failure))
		}
	}
	const save = async (enabled: boolean) => {
		if (!draft) return
		setSaving(true)
		setError("")
		try {
			await AgentMonitorServiceClient.configureAgentMonitor(
				AgentMonitorSettings.create({
					...draft,
					enabled,
					capabilities: filters
						.split(",")
						.map((value) => value.trim())
						.filter(Boolean),
				}),
			)
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			setSaving(false)
		}
	}
	const open = (url: string) =>
		void UiServiceClient.openUrl(StringRequest.create({ value: url })).catch((failure) => setError(pipelineError(failure)))
	const stale = Boolean(error || state?.error || !state?.config?.enabled)
	const agents = state?.agents ?? []
	const visible = agents.filter((agent) =>
		`${agent.name} ${agent.capabilities.join(" ")}`.toLowerCase().includes(search.toLowerCase()),
	)
	return (
		<section aria-label="Agent monitor" className="flex flex-col gap-3 min-w-0">
			<p className="text-sm text-description m-0">
				Monitor an Azure DevOps agent pool. Saved for this workspace; refreshes every minute while monitoring is enabled,
				even when this view is closed.
			</p>
			{draft ? (
				<>
					<label className="text-sm flex flex-col gap-1">
						Agent-pool URL
						<input
							aria-describedby="agent-pool-url-help"
							className={fieldClass}
							onChange={(event) => setDraft({ ...draft, queueUrl: event.target.value })}
							placeholder="Paste your Azure DevOps agent-pool URL"
							value={draft.queueUrl}
						/>
					</label>
					<p className="text-xs text-description m-0" id="agent-pool-url-help">
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
						{state?.config?.enabled && (
							<Button
								disabled={saving}
								onClick={() => {
									setSaving(true)
									void AgentMonitorServiceClient.configureAgentMonitor(
										AgentMonitorSettings.create({ ...state.config, enabled: false }),
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
					Search matching agents
					<input className={fieldClass} onChange={(event) => setSearch(event.target.value)} value={search} />
				</label>
			)}
			{Boolean(state?.updated) && visible.length === 0 && (
				<p className="text-sm text-description">No agents match these filters.</p>
			)}
			<ul className="list-none m-0 p-0">
				{visible.map((agent) => (
					<li className="border-b border-panel-border py-3 flex flex-col gap-1 min-w-0" key={agent.id}>
						<button className="text-left text-link break-all" onClick={() => open(agent.url)}>
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
						{agent.busy &&
							(agent.jobUrl ? (
								<button className="text-left text-link text-xs" onClick={() => open(agent.jobUrl)}>
									{agent.jobName || "Current job"}
								</button>
							) : (
								<span className="text-xs">{agent.jobName || "Job assigned"}</span>
							))}
					</li>
				))}
			</ul>
		</section>
	)
}
