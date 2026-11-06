import { DEFAULT_GRAFANA_CONFIG, type GrafanaSetup, MACHINE_METRICS, METRIC_LABELS } from "@shared/grafana-metrics"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { AgentMonitorServiceClient as client } from "@/services/grpc-client"
import { MachineMetricsView } from "./MachineMetricsView"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

export function GrafanaSettings({ onChanged }: { onChanged?: () => void }) {
	const [open, setOpen] = useState(false)
	return (
		<div>
			<Button onClick={() => setOpen(!open)} size="sm" variant="secondary">
				{open ? "Close Grafana setup" : "Grafana machine metrics…"}
			</Button>
			{open && <ConnectionForm onChanged={onChanged} />}
		</div>
	)
}

function ConnectionForm({ onChanged }: { onChanged?: () => void }) {
	const [testMachine, setTestMachine] = useState(false)
	const [advanced, setAdvanced] = useState(false)
	const [needsServer, setNeedsServer] = useState(false)
	const [setup, setSetup] = useState<GrafanaSetup>({ config: DEFAULT_GRAFANA_CONFIG, hasToken: false, panels: [] })
	const [busy, setBusy] = useState(true)
	const [error, setError] = useState("")
	const [message, setMessage] = useState("")
	useEffect(() => {
		let active = true
		void client
			.getGrafanaSettings(EmptyRequest.create({}))
			.then((response) => {
				if (active) {
					const loaded = JSON.parse(response.value)
					setSetup(loaded)
					setNeedsServer(!loaded.config.url)
				}
			})
			.catch((failure) => {
				if (active) setError(pipelineError(failure))
			})
			.finally(() => {
				if (active) setBusy(false)
			})
		return () => {
			active = false
		}
	}, [])
	const change = (field: "url" | "dashboardUid" | "hostVariable", value: string) =>
		setSetup({
			...setup,
			config: { ...setup.config, [field]: value, ...(field === "url" || field === "dashboardUid" ? { panels: {} } : {}) },
			...(field === "url" || field === "dashboardUid" ? { panels: [] } : {}),
		})
	const action = async (kind: "save" | "token" | "inspect" | "remove" | "connect" | "connectToken") => {
		setBusy(true)
		setError("")
		setMessage("")
		try {
			let response = await client.configureGrafana(StringRequest.create({ value: JSON.stringify(setup.config) }))
			if (kind === "token") response = await client.setGrafanaToken(EmptyRequest.create({}))
			if (kind === "inspect") response = await client.inspectGrafana(EmptyRequest.create({}))
			if (kind === "remove") response = await client.removeGrafanaToken(EmptyRequest.create({}))
			if (kind === "connect" || kind === "connectToken") {
				if (kind === "connectToken" || !(JSON.parse(response.value) as GrafanaSetup).hasToken)
					response = await client.setGrafanaToken(EmptyRequest.create({}))
				if (
					!(JSON.parse(response.value) as GrafanaSetup).hasToken ||
					(JSON.parse(response.value) as GrafanaSetup).cancelled
				)
					return
				response = await client.discoverGrafana(EmptyRequest.create({}))
			}
			const result = JSON.parse(response.value) as GrafanaSetup
			setNeedsServer(!result.config.url)
			setSetup({
				...result,
				panels: kind === "inspect" || kind === "connect" || kind === "connectToken" ? result.panels : setup.panels,
			})
			setMessage(
				kind === "connect" || kind === "connectToken"
					? "Connected. Dashboard and metric panels were found and saved automatically."
					: kind === "inspect"
						? "Dashboard loaded. Select the matching panels below, then save."
						: "Grafana settings saved.",
			)
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			onChanged?.()
			setBusy(false)
		}
	}
	return (
		<fieldset className="border border-panel-border p-3 mt-2 flex flex-col gap-2 min-w-0" disabled={busy}>
			<legend>Grafana connection</legend>
			<p className="text-xs text-description m-0">
				Enter your token once. PlinyCode finds the machine dashboard and supported metric panels, then uses each agent's
				machine name automatically. Saved for this editor and shared by all agent pools.
			</p>
			{(needsServer || advanced) && (
				<>
					<label className="text-sm flex flex-col gap-1">
						Grafana server URL
						<input
							className={fieldClass}
							onChange={(e) => change("url", e.target.value)}
							placeholder="https://grafana.example.com"
							value={setup.config.url}
						/>
					</label>
				</>
			)}
			{needsServer && (
				<p className="text-xs text-description m-0">
					Enter the server address once on a new installation. Tokens do not contain a server address.
				</p>
			)}
			<Button onClick={() => void action("connect")} size="sm">
				{busy ? "Connecting…" : setup.hasToken ? "Connect automatically" : "Enter token and connect…"}
			</Button>
			{setup.hasToken && (
				<Button onClick={() => void action("connectToken")} size="sm" variant="secondary">
					Replace token…
				</Button>
			)}
			<p className="text-xs text-description m-0">
				{setup.hasToken ? "A token is stored for the saved server." : "No token stored for the saved server."}
			</p>
			{Object.keys(setup.config.panels).length > 0 && (
				<p className="text-xs m-0">
					Available:{" "}
					{MACHINE_METRICS.filter((kind) => setup.config.panels[kind])
						.map((kind) => METRIC_LABELS[kind])
						.join(", ")}
					. Open Machine metrics under an agent to see live readings.
				</p>
			)}
			<Button aria-expanded={advanced} onClick={() => setAdvanced(!advanced)} size="sm" variant="secondary">
				{advanced ? "Hide advanced setup" : "Advanced setup"}
			</Button>
			{advanced && (
				<>
					<label className="text-sm flex flex-col gap-1">
						Dashboard UID
						<input
							className={fieldClass}
							onChange={(e) => change("dashboardUid", e.target.value)}
							value={setup.config.dashboardUid}
						/>
						<span className="text-xs text-description">The UID in the dashboard URL: /d/UID/dashboard-name.</span>
					</label>
					<label className="text-sm flex flex-col gap-1">
						Host variable
						<input
							className={fieldClass}
							onChange={(e) => change("hostVariable", e.target.value)}
							value={setup.config.hostVariable}
						/>
					</label>
					<div className="flex flex-wrap gap-2">
						<Button onClick={() => void action("token")} size="sm">
							Enter token…
						</Button>
						<Button onClick={() => void action("inspect")} size="sm" variant="secondary">
							Load dashboard panels
						</Button>
						<Button onClick={() => void action("remove")} size="sm" variant="secondary">
							Remove token
						</Button>
					</div>
					<p className="text-xs text-description m-0">
						Token entry uses a masked editor prompt and the editor's secret storage. Browser sign-in is separate.
					</p>
					{MACHINE_METRICS.map((kind) => (
						<label className="text-sm flex flex-col gap-1" key={kind}>
							{METRIC_LABELS[kind]} panel
							<select
								className={fieldClass}
								onChange={(e) => {
									const panels = { ...setup.config.panels }
									if (e.target.value) panels[kind] = Number(e.target.value)
									else delete panels[kind]
									setSetup({ ...setup, config: { ...setup.config, panels } })
								}}
								value={setup.config.panels[kind] ?? ""}>
								<option value="">Not configured</option>
								{setup.config.panels[kind] && !setup.panels.some((p) => p.id === setup.config.panels[kind]) && (
									<option value={setup.config.panels[kind]}>Saved panel #{setup.config.panels[kind]}</option>
								)}
								{setup.panels.map((p) => (
									<option disabled={Boolean(p.problem)} key={p.id} value={p.id}>
										{p.title} {p.unit ? `(${p.unit})` : ""}
										{p.problem ? ` — ${p.problem}` : ""}
									</option>
								))}
							</select>
						</label>
					))}
					<p className="text-xs text-description m-0">
						Choose load panels in percent and free/available disk panels in bytes. Hardware panels can expose model,
						core count, memory and driver labels when the monitoring source collects them.
					</p>
					<Button onClick={() => void action("save")} size="sm">
						{busy ? "Connecting…" : "Save Grafana settings"}
					</Button>
					<Button onClick={() => setTestMachine(!testMachine)} size="sm" variant="secondary">
						{testMachine ? "Close machine test" : "Test a machine"}
					</Button>
					{testMachine && <MachineMetricsView hostname="" />}
				</>
			)}
			{error && (
				<p className="text-sm text-error m-0" role="alert">
					{error}
				</p>
			)}
			{message && (
				<p className="text-xs m-0" role="status">
					{message}
				</p>
			)}
		</fieldset>
	)
}
