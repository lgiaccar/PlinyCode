import { diskReading, isLowDiskSpace, type MachineMetrics } from "@shared/grafana-metrics"

/** One warning per low-space episode and volume in this editor session. */
export class GrafanaDiskAlerts {
	private readonly states = new Map<string, { low: boolean; updated: number }>()
	check(scope: string, data: MachineMetrics, now = Date.now()): string[] {
		const warnings: string[] = []
		for (const result of data.results) {
			if (result.kind !== "disk" || result.error) continue
			for (const series of result.series) {
				if (!["bytes", "decbytes"].includes(series.unit)) continue
				const reading = diskReading(series, now)
				if (!reading || reading.stale) continue
				const key = JSON.stringify([
					scope,
					data.host,
					series.name,
					Object.entries(series.labels).sort(([a], [b]) => a.localeCompare(b)),
				])
				const previous = this.states.get(key)
				if (previous && reading.updated <= previous.updated) continue
				const low = isLowDiskSpace(reading.latest, series.unit)
				if (low && !previous?.low) {
					const volume = series.labels.mountpoint || series.labels.volume || series.labels.device || series.name
					warnings.push(
						`PlinyCode: Low disk space on ${data.host} (${volume}): ${(reading.latest / 1e9).toFixed(1)} GB free, below 50 GB.`,
					)
				}
				this.states.set(key, { low, updated: reading.updated })
			}
		}
		return warnings
	}
}
