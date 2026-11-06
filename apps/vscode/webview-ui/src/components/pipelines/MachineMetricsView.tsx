import { type MachineMetrics, type MachineSeries, METRIC_RANGES, type MetricRange, metricSummary } from "@shared/grafana-metrics"
import { AgentMetricsRequest } from "@shared/proto/cline/agent_monitor"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { AgentMonitorServiceClient } from "@/services/grpc-client"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

const rangeLabels: Record<MetricRange, string> = {
	"1h": "Last hour",
	"3h": "Last 3 hours",
	"24h": "Last 24 hours",
	"1w": "Last week",
	"30d": "Last 30 days",
}
export function MachineMetricsView({ hostname }: { hostname: string }) {
	const [draft, setDraft] = useState(hostname)
	const [host, setHost] = useState("")
	const [range, setRange] = useState<MetricRange>("24h")
	const [refresh, setRefresh] = useState(0)
	const [data, setData] = useState<MachineMetrics>()
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	// Refresh only an explicitly selected host while the view remains visible.
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh is an explicit retry signal.
	useEffect(() => {
		if (!host) return
		let active = true
		let pending = false
		setData(undefined)
		const load = async () => {
			if (pending) return
			pending = true
			setBusy(true)
			setError("")
			try {
				const response = await AgentMonitorServiceClient.queryAgentMetrics(AgentMetricsRequest.create({ host, range }))
				if (active) setData(JSON.parse(response.value))
			} catch (failure) {
				if (active) setError(pipelineError(failure))
			} finally {
				pending = false
				if (active) setBusy(false)
			}
		}
		void load()
		const timer = setInterval(() => {
			if (document.visibilityState === "visible") void load()
		}, 60_000)
		return () => {
			active = false
			clearInterval(timer)
		}
	}, [host, range, refresh])
	return (
		<section
			aria-label={`Machine metrics for ${hostname}`}
			className="border border-panel-border rounded p-3 mt-2 flex flex-col gap-2 min-w-0">
			<p className="m-0 text-xs text-description">
				Machine load from Grafana, separate from agent busy time. Confirm the exact host/instance used by the dashboard.
			</p>
			<label className="text-sm flex flex-col gap-1">
				Grafana host
				<input className={fieldClass} onChange={(e) => setDraft(e.target.value)} value={draft} />
			</label>
			<div className="flex flex-wrap gap-2 items-center">
				<label className="text-sm">
					Time range{" "}
					<select className={fieldClass} onChange={(e) => setRange(e.target.value as MetricRange)} value={range}>
						{(Object.keys(METRIC_RANGES) as MetricRange[]).map((r) => (
							<option key={r} value={r}>
								{rangeLabels[r]}
							</option>
						))}
					</select>
				</label>
				<Button
					disabled={busy || !draft.trim()}
					onClick={() => {
						setHost(draft.trim())
						setRefresh((n) => n + 1)
					}}
					size="sm">
					{busy ? "Loading…" : "Load metrics"}
				</Button>
			</div>
			{error && (
				<p className="text-error text-sm m-0" role="alert">
					{error}
					{data ? " Showing previous results." : " Open Grafana machine metrics setup to check the connection."}
				</p>
			)}
			{data && (
				<>
					<p className="text-xs text-description m-0">
						{data.host} · Queried {new Date(data.to).toLocaleString()} · Refreshes every minute while open. Disk and
						hardware show current query results; load uses the selected range.
					</p>
					{data.results.map((result) => (
						<div className="border-t border-panel-border pt-2" key={result.kind}>
							<h3 className="text-sm m-0 mb-1">{result.title}</h3>
							{result.error ? (
								<p className="text-xs text-description m-0">{result.error}</p>
							) : result.series.length === 0 ? (
								<p className="text-xs text-description m-0">
									No data returned for this host. The metric may not be collected.
								</p>
							) : (
								result.series.map((series, index) => (
									<SeriesView
										chart={result.kind === "cpu" || result.kind === "gpu"}
										data={data}
										hardware={result.kind === "cpuInfo" || result.kind === "gpuInfo"}
										key={`${index}-${series.name}`}
										series={series}
									/>
								))
							)}
						</div>
					))}
					<p className="text-xs text-description m-0">
						Statistics describe returned query samples, not unsampled peaks. Missing history stays missing; retention
						and exporter freshness are controlled by your monitoring system. Query timestamps do not prove the
						exporter is fresh.
					</p>
				</>
			)}
		</section>
	)
}

function valueText(value: number, unit: string): string {
	if (unit === "percent") return `${value.toFixed(1)}%`
	if (unit === "bytes" || unit === "decbytes") {
		const base = unit === "bytes" ? 1024 : 1000
		const index = Math.min(4, Math.max(0, Math.floor(Math.log(Math.max(1, value)) / Math.log(base))))
		return `${(value / base ** index).toFixed(1)} ${(unit === "bytes" ? ["B", "KiB", "MiB", "GiB", "TiB"] : ["B", "kB", "MB", "GB", "TB"])[index]}`
	}
	return `${Number(value.toPrecision(5))}${unit && !["none", "short"].includes(unit) ? ` ${unit}` : ""}`
}
function SeriesView({
	series,
	data,
	chart,
	hardware,
}: {
	series: MachineSeries
	data: MachineMetrics
	chart: boolean
	hardware: boolean
}) {
	const summary = metricSummary(series, data.from, data.to, data.stepMs)
	const labels = Object.entries(series.labels).filter(([key]) => key !== "__name__")
	return (
		<div className="text-xs flex flex-col gap-1 mt-2 break-words">
			<div>{series.name}</div>
			{hardware ? (
				<dl className="m-0 grid grid-cols-2 gap-x-2">
					{labels.map(([key, value]) => (
						<div key={key}>
							<dt className="text-description">{key}</dt>
							<dd className="m-0">{value}</dd>
						</div>
					))}
				</dl>
			) : (
				labels.length > 0 && (
					<div className="text-description">{labels.map(([key, value]) => `${key}: ${value}`).join(" · ")}</div>
				)
			)}
			{!summary ? (
				<span className="text-description">No numeric samples available.</span>
			) : (
				<>
					<strong>
						{hardware ? "Value: " : ""}
						{valueText(summary.latest, series.unit)}
						{summary.stale ? " · Older query sample" : ""}
					</strong>
					{chart && (
						<>
							<LoadChart data={data} series={series} />
							<span>
								Sample average {valueText(summary.average, series.unit)} · Peak{" "}
								{valueText(summary.peak, series.unit)} · P95 {valueText(summary.p95, series.unit)}
							</span>
							<span className="text-description">
								{(summary.coverage * 100).toFixed(1)}% query sample coverage ·{" "}
								{Math.round((series.stepMs ?? data.stepMs) / 1000)}s resolution · Last sample{" "}
								{new Date(summary.updated).toLocaleString()}
							</span>
						</>
					)}
				</>
			)}
		</div>
	)
}

function LoadChart({ series, data }: { series: MachineSeries; data: MachineMetrics }) {
	const paths: string[] = []
	const isolated: { x: number; y: number }[] = []
	const points = series.points.filter((p) => p.time >= data.from && p.time <= data.to)
	const minimum = points.reduce((value, p) => Math.min(value, p.value ?? 0), 0)
	const maximum = points.reduce((value, p) => Math.max(value, p.value ?? 0), 100)
	const gap = (series.stepMs ?? data.stepMs) * 1.5
	let path = ""
	let previous = 0
	for (const [index, point] of points.entries()) {
		if (point.value === null || point.time - previous > gap) {
			if (path) paths.push(path)
			path = ""
		}
		if (point.value !== null) {
			const x = 2 + (316 * (point.time - data.from)) / (data.to - data.from)
			const y = 75 - (70 * (point.value - minimum)) / (maximum - minimum)
			const before = points[index - 1]
			const after = points[index + 1]
			if (
				!(before && before.value !== null && point.time - before.time <= gap) &&
				!(after && after.value !== null && after.time - point.time <= gap)
			)
				isolated.push({ x, y })
			path += `${path ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)} `
		}
		previous = point.time
	}
	if (path) paths.push(path)
	return (
		<svg
			aria-label={`${series.name} load over the selected time range, ${minimum} to ${maximum} percent`}
			className="w-full max-w-xl text-link"
			role="img"
			viewBox="0 0 320 85">
			<title>
				{series.name}: {minimum}–{maximum}% load; gaps indicate missing samples
			</title>
			<path d="M0 5H320 M0 75H320" opacity="0.2" stroke="currentColor" />
			<g fill="none" stroke="currentColor" strokeWidth="1.5">
				{paths.map((d, i) => (
					<path d={d} key={i} />
				))}
			</g>
			{isolated.map((point, index) => (
				<circle cx={point.x} cy={point.y} fill="currentColor" key={index} r="2" />
			))}
		</svg>
	)
}
