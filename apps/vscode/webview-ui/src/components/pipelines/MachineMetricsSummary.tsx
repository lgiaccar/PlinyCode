import { type MachineMetrics, metricSummary } from "@shared/grafana-metrics"
import { HardDrive } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { MachineMetricsView, valueText } from "./MachineMetricsView"
import { queryMachineSummary } from "./machine-summary-query"
import { pipelineError } from "./PipelineLaunchForm"

export function MachineMetricsSummary({ hostname, ready }: { hostname: string; ready: boolean }) {
	const element = useRef<HTMLElement>(null)
	const [visible, setVisible] = useState(false)
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
	}, [hostname, ready])
	useEffect(() => {
		if (!ready || !visible || !hostname) return
		let active = true
		let pending = false
		const canQuery = () => active && document.visibilityState === "visible"
		const load = async () => {
			if (pending || !canQuery()) return
			pending = true
			try {
				const result = await queryMachineSummary(hostname, canQuery)
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
	}, [hostname, ready, visible])
	if (!ready) return null
	const disk = data?.results.find((result) => result.kind === "disk")
	const readings = disk?.error
		? []
		: (disk?.series.flatMap((series) => {
				const summary = data && metricSummary(series, data.from, data.to, data.stepMs)
				return summary ? [{ series, summary }] : []
			}) ?? [])
	const problem = error || disk?.error || "No disk samples returned for this machine."
	return (
		<section
			aria-label={`Machine summary for ${hostname}`}
			className="min-w-0 max-w-full"
			ref={element}
			style={{ flex: details ? "1 1 320px" : "0 1 auto" }}>
			<div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
				<span className="inline-flex items-center gap-1 text-description">
					<HardDrive aria-hidden="true" size={14} />
					Disk free:
				</span>
				{readings.length ? (
					readings.slice(0, 3).map(({ series, summary }, index) => {
						const volume =
							series.labels.mountpoint ||
							series.labels.volume ||
							series.labels.device ||
							(readings.length > 1 ? series.name : "")
						return (
							<span
								className="min-w-0 break-words"
								key={`${series.name}-${index}`}
								title={`${series.name} · ${JSON.stringify(series.labels)} · Last sample ${new Date(summary.updated).toLocaleString()}`}>
								{volume && <span className="text-description">{volume} </span>}
								<strong>{valueText(summary.latest, series.unit)}</strong>
								{summary.stale && <span className="text-warning"> · Older sample</span>}
							</span>
						)
					})
				) : (
					<span className="text-description" title={data || error ? problem : undefined}>
						{data || error ? "Unavailable" : "Loading…"}
					</span>
				)}
				{readings.length > 3 && (
					<span className="text-description" title="Open Details for all volumes">
						+{readings.length - 3} volumes
					</span>
				)}
				{error && readings.length > 0 && (
					<span className="text-warning" role="status" title={error}>
						Previous reading
					</span>
				)}
				<Button
					aria-expanded={details}
					onClick={() => setDetails(!details)}
					size="xs"
					title="CPU/GPU charts, disk volumes and hardware details"
					variant="ghost">
					{details ? "Hide details" : "Details"}
				</Button>
			</div>
			{details && visible && <MachineMetricsView hostname={hostname} key={hostname} />}
		</section>
	)
}
