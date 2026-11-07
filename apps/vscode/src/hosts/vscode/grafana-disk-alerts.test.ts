import type { MachineMetrics } from "@shared/grafana-metrics"
import { describe, expect, it } from "vitest"
import { GrafanaDiskAlerts } from "./grafana-disk-alerts"

const now = 1_000_000
function data(value: number | null, time = now, volume = "C:"): MachineMetrics {
	return {
		host: "build-01",
		from: 0,
		to: time,
		stepMs: 4_320_000,
		results: [
			{
				kind: "disk",
				title: "Disk",
				error: "",
				series: [{ name: "Free", unit: "bytes", labels: { volume }, points: [{ time, value }] }],
			},
		],
	}
}
describe("Grafana low disk warnings", () => {
	it("warns on first low sample, deduplicates, and rearms only after recovery", () => {
		const alerts = new GrafanaDiskAlerts()
		expect(alerts.check("server", data(49e9), now)[0]).toContain("build-01 (C:): 49.0 GB")
		expect(alerts.check("server", data(48e9, now + 1), now + 1)).toEqual([])
		expect(alerts.check("server", data(50e9, now + 2), now + 2)).toEqual([])
		expect(alerts.check("server", data(49e9, now + 3), now + 3)).toHaveLength(1)
	})
	it("uses decimal GB, tracks volumes and servers separately, and ignores non-byte units", () => {
		const alerts = new GrafanaDiskAlerts()
		expect(alerts.check("server", data(49 * 1024 ** 3), now)).toEqual([])
		expect(alerts.check("server", data(0, now + 1), now + 1)).toHaveLength(1)
		expect(alerts.check("server", data(0, now, "D:"), now)).toHaveLength(1)
		expect(alerts.check("other", data(0), now)).toHaveLength(1)
		const percent = data(1)
		percent.results[0].series[0].unit = "percent"
		expect(alerts.check("percent", percent, now)).toEqual([])
	})
	it("does not alert or rearm from stale, missing, failed, or out-of-order data", () => {
		const alerts = new GrafanaDiskAlerts()
		expect(alerts.check("server", data(1, now - 300_001), now)).toEqual([])
		expect(alerts.check("server", data(null), now)).toEqual([])
		expect(alerts.check("server", data(-1), now)).toEqual([])
		expect(alerts.check("server", data(1), now)).toHaveLength(1)
		expect(alerts.check("server", data(60e9, now - 1), now)).toEqual([])
		const failed = data(60e9, now + 1)
		failed.results[0].error = "Query failed"
		expect(alerts.check("server", failed, now + 1)).toEqual([])
		expect(alerts.check("server", data(1, now + 2), now + 2)).toEqual([])
	})
	it("selects the newest timestamp instead of the last returned point", () => {
		const sample = data(60e9, now - 1)
		sample.results[0].series[0].points.unshift({ time: now, value: 1 })
		expect(new GrafanaDiskAlerts().check("server", sample, now)).toHaveLength(1)
	})
})
