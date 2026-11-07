/** Dashboard panel mappings are local configuration, never built-in private endpoints. */
export const MACHINE_METRICS = ["cpu", "gpu", "disk", "cpuInfo", "gpuInfo"] as const
export type MachineMetric = (typeof MACHINE_METRICS)[number]
export const METRIC_LABELS: Record<MachineMetric, string> = {
	cpu: "CPU load",
	gpu: "GPU load",
	disk: "Available disk space",
	cpuInfo: "CPU characteristics",
	gpuInfo: "GPU characteristics",
}
export const METRIC_RANGES = {
	"1h": 3_600_000,
	"3h": 10_800_000,
	"24h": 86_400_000,
	"1w": 604_800_000,
	"30d": 2_592_000_000,
} as const
export type MetricRange = keyof typeof METRIC_RANGES
export interface GrafanaConfig {
	url: string
	dashboardUid: string
	hostVariable: string
	panels: Partial<Record<MachineMetric, number>>
}
export const DEFAULT_GRAFANA_CONFIG: GrafanaConfig = { url: "", dashboardUid: "", hostVariable: "host", panels: {} }
export interface GrafanaPanelChoice {
	id: number
	title: string
	unit: string
	problem: string
}
export interface GrafanaSetup {
	cancelled?: boolean
	config: GrafanaConfig
	hasToken: boolean
	panels: GrafanaPanelChoice[]
}
export interface MetricPoint {
	time: number
	value: number | null
}
export interface MachineSeries {
	stepMs?: number
	name: string
	unit: string
	labels: Record<string, string>
	points: MetricPoint[]
}
export interface MachineMetricResult {
	kind: MachineMetric
	title: string
	series: MachineSeries[]
	error: string
}
export interface MachineMetrics {
	host: string
	from: number
	to: number
	stepMs: number
	results: MachineMetricResult[]
}

/** Sample statistics, not a claim about unobserved time or unsampled peaks. */
export function metricSummary(series: MachineSeries, from: number, to: number, stepMs: number) {
	stepMs = series.stepMs ?? stepMs
	const points = series.points.filter(
		(p): p is { time: number; value: number } =>
			p.value !== null && Number.isFinite(p.value) && p.time >= from && p.time <= to,
	)
	if (!points.length) return undefined
	const values = points.map((p) => p.value).sort((a, b) => a - b)
	const last = points.reduce((latest, point) => (point.time > latest.time ? point : latest))
	return {
		latest: last.value,
		updated: last.time,
		average: values.reduce((a, b) => a + b, 0) / values.length,
		peak: values[values.length - 1],
		p95: values[Math.ceil(values.length * 0.95) - 1],
		coverage: Math.min(1, points.length / (Math.floor((to - from) / stepMs) + 1)),
		stale: to - last.time > Math.max(300_000, 2 * stepMs),
	}
}

/** Decimal GB, regardless of whether the display formats bytes as GB or GiB. */
const LOW_DISK_BYTES = 50_000_000_000
export function isLowDiskSpace(value: number, unit: string): boolean {
	return ["bytes", "decbytes"].includes(unit) && Number.isFinite(value) && value >= 0 && value < LOW_DISK_BYTES
}
/** Disk freshness must not inherit the coarse step of a month-long load chart. */
export function diskReading(series: MachineSeries, now: number) {
	const points = series.points.filter(
		(point) => point.value !== null && Number.isFinite(point.value) && point.value >= 0 && point.time <= now,
	)
	if (!points.length) return undefined
	const latest = points.reduce((a, b) => (a.time > b.time ? a : b))
	return { latest: latest.value as number, updated: latest.time, stale: now - latest.time > 300_000 }
}
