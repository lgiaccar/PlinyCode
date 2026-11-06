import { type MachineMetric, type MachineMetrics, METRIC_RANGES, type MetricRange, metricSummary } from "@shared/grafana-metrics"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { MachineMetricsView, valueText } from "./MachineMetricsView"
import { queryMachineSummary } from "./machine-summary-query"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

export function MachineMetricsSummary({ hostname, ready }: { hostname: string; ready: boolean }) {
	const element = useRef<HTMLElement>(null)
	const [visible, setVisible] = useState(false)
	const [range, setRange] = useState<MetricRange>("24h")
	const [details, setDetails] = useState(false)
	const [data, setData] = useState<MachineMetrics>()
	const [error, setError] = useState("")
	useEffect(() => {
		if (!ready || !element.current) return
		const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
		observer.observe(element.current)
		return () => observer.disconnect()
	}, [ready])
	useEffect(() => {
		setData(undefined)
		setError("")
	}, [hostname, range, ready])
	useEffect(() => {
		if (!ready || !visible || !hostname) return
		let active = true
		let pending = false
		const canQuery = () => active && document.visibilityState === "visible"
		const load = async () => {
			if (pending || !canQuery()) return
			pending = true
			try {
				const result = await queryMachineSummary(hostname, range, canQuery)
				if (active && result) {
					setData(result)
					setError("")
				}
			} catch (failure) {
				if (active) setError(pipelineError(failure))
			} finally {
				pending = false
			}
		}
		void load()
		const timer = setInterval(() => void load(), 60_000)
		document.addEventListener("visibilitychange", load)
		return () => {
			active = false
			clearInterval(timer)
			document.removeEventListener("visibilitychange", load)
		}
	}, [hostname, range, ready, visible])
	return (
		<section
			aria-label={`Machine summary for ${hostname}`}
			className="border border-panel-border rounded p-3 min-w-0 flex flex-col gap-2"
			ref={element}
			style={{ flex: "1 1 320px" }}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<strong className="text-xs">Machine load</strong>
				{ready && (
					<label className="text-xs flex items-center gap-1">
						Period
						<select
							aria-label={`Machine summary period for ${hostname}`}
							className={fieldClass}
							onChange={(event) => setRange(event.target.value as MetricRange)}
							value={range}>
							{(Object.keys(METRIC_RANGES) as MetricRange[]).map((value) => (
								<option key={value} value={value}>
									{value === "30d" ? "1 month" : value === "1w" ? "1 week" : value}
								</option>
							))}
						</select>
					</label>
				)}
			</div>
			{!ready ? (
				<p className="text-xs text-description m-0">Connect Grafana above to see machine readings.</p>
			) : (
				<>
					{!data && !error && <p className="text-xs text-description m-0">Loading machine readings…</p>}
					{error && (
						<p className="text-xs text-error m-0 break-words" role="status">
							{data ? "Refresh failed — previous readings. " : "Readings unavailable. "}
							{error}
						</p>
					)}
					{data && (
						<>
							<div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(100px, 1fr))" }}>
								<MetricTile data={data} kind="cpu" label="CPU average" />
								<MetricTile data={data} kind="gpu" label="GPU average" />
								<MetricTile data={data} kind="disk" label="Disk free" />
							</div>
							<p
								className="text-xs text-description m-0"
								title="CPU/GPU values summarize returned samples, not agent busy time. Disk shows the latest query result. Query time does not prove exporter freshness.">
								{range} samples · Disk latest · Queried {new Date(data.to).toLocaleTimeString()}
							</p>
						</>
					)}
					<Button
						aria-expanded={details}
						className="self-start"
						onClick={() => setDetails(!details)}
						size="sm"
						variant="secondary">
						{details ? "Hide details" : "Details & charts"}
					</Button>
					{details && visible && (
						<MachineMetricsView hostname={hostname} initialRange={range} key={`${hostname}-${range}`} />
					)}
				</>
			)}
		</section>
	)
}

function MetricTile({ data, kind, label }: { data: MachineMetrics; kind: MachineMetric; label: string }) {
	const result = data.results.find((entry) => entry.kind === kind)
	const readings = result?.series
		.map((series) => ({ series, summary: metricSummary(series, data.from, data.to, data.stepMs) }))
		.filter((entry) => entry.summary)
	return (
		<div className="min-w-0 text-xs">
			<div className="text-description mb-1">{label}</div>
			{result?.error || !readings?.length ? (
				<span className="text-description" title={result?.error || "No samples returned for this machine."}>
					Unavailable
				</span>
			) : (
				<>
					{readings.slice(0, 3).map(({ series, summary }, index) => {
						if (!summary) return null
						const value = kind === "disk" ? summary.latest : summary.average
						return (
							<div
								className="mb-1"
								key={index}
								title={`${series.name} · ${JSON.stringify(series.labels)} · Last sample ${new Date(summary.updated).toLocaleString()}`}>
								{(readings.length > 1 || kind === "disk") && (
									<div className="truncate text-description">
										{series.labels.mountpoint || series.labels.volume || series.labels.device || series.name}
									</div>
								)}
								<strong className="text-base">{valueText(value, series.unit)}</strong>
								{kind !== "disk" && (
									<>
										<div
											aria-hidden="true"
											className="h-1 rounded overflow-hidden bg-[var(--vscode-progressBar-background)]/20">
											<div
												className="h-full bg-[var(--vscode-charts-blue)]"
												style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
											/>
										</div>
										<div className="text-description">
											Latest {valueText(summary.latest, series.unit)} ·{" "}
											{(summary.coverage * 100).toFixed(0)}% coverage
										</div>
									</>
								)}
								{summary.stale && <div className="text-warning">Older sample</div>}
							</div>
						)
					})}
					{readings.length > 3 && <span className="text-description">+{readings.length - 3} more in details</span>}
				</>
			)}
		</div>
	)
}
