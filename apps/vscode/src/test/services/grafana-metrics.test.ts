import { describe, expect, it } from "bun:test"
import { decodeFrame, GrafanaClient, interpolatePromQuery, validateGrafanaConfig } from "../../services/grafana/client"
import { type GrafanaConfig, METRIC_RANGES, metricSummary } from "../../shared/grafana-metrics"

const config: GrafanaConfig = {
	url: "https://grafana.example.com/subpath",
	dashboardUid: "machines",
	hostVariable: "host",
	panels: { cpu: 1, disk: 2, gpuInfo: 3 },
}
const dashboard = {
	dashboard: {
		panels: [
			{
				id: 1,
				title: "CPU load",
				datasource: { uid: "metrics", type: "prometheus" },
				fieldConfig: { defaults: { unit: "percentunit" } },
				targets: [{ expr: '1 - rate(cpu{host=~"$host",mode="idle"}[$__rate_interval])' }],
			},
			{
				id: 2,
				title: "Free disk",
				datasource: { uid: "metrics" },
				fieldConfig: { defaults: { unit: "bytes" } },
				targets: [{ expr: 'disk_free{host="$host"}' }],
			},
			{ id: 3, title: "GPU model", datasource: { uid: "metrics" }, targets: [{ expr: 'gpu_info{host="${host}"}' }] },
		],
	},
}
const frame = (values: unknown[], labels = { volume: "C:" }) => ({
	schema: {
		name: "machine",
		fields: [
			{ name: "Time", type: "time" },
			{ name: "Value", type: "number", labels },
		],
	},
	data: { values: [[1000, 2000, 3000], values] },
})
const json = (value: unknown, status = 200) =>
	new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })

describe("Grafana metric queries", () => {
	it("accepts subpaths and rejects credential-bearing or non-HTTP URLs", () => {
		expect(validateGrafanaConfig({ ...config, url: `${config.url}/` }).url).toBe(config.url)
		for (const url of ["file:///secrets", "https://user:pass@host", "https://host/?token=secret", "https://host/#secret"])
			expect(() => validateGrafanaConfig({ ...config, url })).toThrow()
	})
	it("substitutes a literal host for exact and regex matchers without interpreting metacharacters", () => {
		expect(interpolatePromQuery('up{host=~"${host:regex}"}', "host", "build.example:9100", 3600000, 15000)).toBe(
			'up{host=~"build\\\\.example:9100"}',
		)
		expect(interpolatePromQuery('up{host="$host"}', "host", "build.example", 3600000, 15000)).toBe('up{host="build.example"}')
		for (const host of [".*", 'host"} or up', "host name"])
			expect(() => interpolatePromQuery('up{host="$host"}', "host", host, 3600000, 15000)).toThrow()
		for (const expr of ['up{host!="$host"}', "up", 'up{host="$host",job="$job"}'])
			expect(() => interpolatePromQuery(expr, "host", "build", 3600000, 15000)).toThrow()
	})
	it("queries each supported time range, authenticates without redirects and requests disk/hardware instantly", async () => {
		for (const range of Object.keys(METRIC_RANGES) as (keyof typeof METRIC_RANGES)[]) {
			const calls: { url: string; init?: RequestInit }[] = []
			const fetcher = (async (url, init) => {
				calls.push({ url: String(url), init })
				if (String(url).includes("/dashboards/")) return json(dashboard)
				if (String(url).includes("/datasources/")) return json({ type: "prometheus" })
				return json({ results: { Q0: { frames: [frame([0.1, null, 0.5])] } } })
			}) as typeof fetch
			const to = 3_000_000_000
			const result = await new GrafanaClient(config, "fixture-credential", fetcher).metrics("build-01", range, to)
			expect(result.to - result.from).toBe(METRIC_RANGES[range])
			expect(result.results[0].series[0].points.map((p) => p.value)).toEqual([10, null, 50])
			expect(result.results[1].error).toContain("No dashboard panel")
			const queries = calls.filter((c) => c.url.endsWith("/api/ds/query")).map((c) => JSON.parse(String(c.init?.body)))
			expect(queries).toHaveLength(3)
			expect(queries[0]).toMatchObject({ from: String(to - METRIC_RANGES[range]), to: String(to) })
			expect(queries.map((q) => q.queries[0].instant)).toEqual([false, true, true])
			expect(calls.filter((c) => c.url.includes("/datasources/"))).toHaveLength(1)
			for (const call of calls) {
				expect(call.init?.redirect).toBe("error")
				expect(new Headers(call.init?.headers).get("authorization")).toBe("Bearer fixture-credential")
			}
		}
	})
	it("queries only free disk space for collapsed agent summaries", async () => {
		const expressions: { expr: string; instant: boolean; range: boolean }[] = []
		const client = new GrafanaClient(config, "fixture", (async (url, init) => {
			if (String(url).includes("/dashboards/")) return json(dashboard)
			if (String(url).includes("/datasources/")) return json({ type: "prometheus" })
			expressions.push(...JSON.parse(String(init?.body)).queries)
			return json({ results: { Q0: { frames: [frame([1, 2, 3])] } } })
		}) as typeof fetch)
		const result = await client.metrics("build-01", "24h", 3000, true)
		expect(result.results.map((result) => result.kind)).toEqual(["disk"])
		expect(expressions).toEqual([
			expect.objectContaining({ expr: 'disk_free{host="build-01"}', instant: true, range: false }),
		])
	})
	it("resolves inherited default datasources and preserves unsupported panel choices", async () => {
		const inherited = structuredClone(dashboard)
		Object.assign(inherited.dashboard.panels[0], { datasource: { type: "prometheus" } })
		Object.assign(inherited.dashboard.panels[1], { datasource: null })
		Object.assign(inherited.dashboard.panels[2], { datasource: 42 })
		let defaultReads = 0
		const client = new GrafanaClient(config, "fixture", (async (url) => {
			if (String(url).includes("/dashboards/")) return json(inherited)
			if (String(url).endsWith("/api/datasources")) {
				defaultReads++
				return json([{ uid: "metrics", type: "prometheus", isDefault: true }])
			}
			if (String(url).includes("/datasources/")) return json({ type: "prometheus" })
			return json({ results: { Q0: { frames: [frame([0.1, null, 0.5])] } } })
		}) as typeof fetch)
		const panels = await client.panels()
		expect(panels).toHaveLength(3)
		expect(panels[2].problem).toContain("Unsupported")
		const result = await client.metrics("build", "1h")
		expect(result.results[0].error).toBe("")
		expect(result.results[2].error).toBe("")
		expect(defaultReads).toBe(1)
	})
	it("refuses a non-Prometheus default datasource", async () => {
		const inherited = structuredClone(dashboard)
		Object.assign(inherited.dashboard.panels[0], { datasource: { type: "prometheus" } })
		const client = new GrafanaClient(config, "fixture", (async (url) =>
			String(url).includes("/dashboards/")
				? json(inherited)
				: json([{ uid: "other", type: "influxdb", isDefault: true }])) as typeof fetch)
		const result = await client.metrics("build", "1h")
		expect(result.results[0].error).toContain("default Prometheus")
	})
	it("discovers a dashboard, host variable and free-space panels without user mappings", async () => {
		const automatic = structuredClone(dashboard)
		Object.assign(automatic.dashboard.panels[0], { type: "timeseries" })
		const current = { ...automatic.dashboard.panels[0], id: 4, title: "CPU Now", type: "stat" }
		automatic.dashboard.panels.push(current)
		automatic.dashboard.panels.push({ ...automatic.dashboard.panels[1], id: 5, title: "Used disk" })
		const calls: string[] = []
		const client = new GrafanaClient({ ...config, dashboardUid: "", panels: {} }, "fixture", (async (url) => {
			calls.push(String(url))
			return String(url).includes("/api/search")
				? json([{ uid: "discovered", title: "Machine resources" }])
				: json(automatic)
		}) as typeof fetch)
		const result = await client.discover()
		expect(result.config).toMatchObject({
			dashboardUid: "discovered",
			hostVariable: "host",
			panels: { cpu: 1, disk: 2, gpuInfo: 3 },
		})
		expect(result.config.panels.gpu).toBeUndefined()
		expect(calls).toHaveLength(2)
	})
	it("prefers a configured dashboard without requesting a global dashboard search", async () => {
		const client = new GrafanaClient(config, "fixture", (async (url) => {
			expect(String(url)).toContain("/dashboards/uid/machines")
			return json(dashboard)
		}) as typeof fetch)
		expect((await client.discover()).config.panels.cpu).toBe(1)
	})
	it("does not treat a region selector as a machine selector", async () => {
		const regional = structuredClone(dashboard)
		regional.dashboard.panels = [{ ...regional.dashboard.panels[0], targets: [{ expr: 'cpu_load{region="$region"}' }] }]
		const client = new GrafanaClient(config, "fixture", (async (url) =>
			String(url).includes("/api/search") ? json([]) : json(regional)) as typeof fetch)
		await expect(client.discover()).rejects.toThrow("No matching machine panels")
	})
	it("does not guess between equally matching dashboards", async () => {
		const client = new GrafanaClient({ ...config, dashboardUid: "" }, "fixture", (async (url) =>
			String(url).includes("/api/search")
				? json([
						{ uid: "one", title: "Machine A" },
						{ uid: "two", title: "Machine B" },
					])
				: json(dashboard)) as typeof fetch)
		await expect(client.discover()).rejects.toThrow("More than one dashboard")
	})
	it("ignores ambiguous load panels, used-space panels and unscoped queries", async () => {
		const ambiguous = structuredClone(dashboard)
		ambiguous.dashboard.panels = [
			ambiguous.dashboard.panels[0],
			{ ...ambiguous.dashboard.panels[0], id: 4 },
			{ ...ambiguous.dashboard.panels[1], title: "Used disk" },
			{ ...ambiguous.dashboard.panels[2], targets: [{ expr: "gpu_info" }] },
		]
		const client = new GrafanaClient(config, "fixture", (async (url) =>
			String(url).includes("/api/search") ? json([]) : json(ambiguous)) as typeof fetch)
		await expect(client.discover()).rejects.toThrow("No matching machine panels")
	})
	it("can discover after a saved dashboard was removed but does not hide auth failures", async () => {
		const client = new GrafanaClient(config, "fixture", (async (url) => {
			if (String(url).endsWith("/machines")) return json({}, 404)
			return String(url).includes("/api/search") ? json([{ uid: "new", title: "Agent resources" }]) : json(dashboard)
		}) as typeof fetch)
		expect((await client.discover()).config.dashboardUid).toBe("new")
		const denied = new GrafanaClient(config, "fixture", (async () => json({}, 403)) as unknown as typeof fetch)
		await expect(denied.discover()).rejects.toThrow("HTTP 403")
	})
	it("reports auth failures without echoing server bodies", async () => {
		const client = new GrafanaClient(config, "fixture", (async () =>
			json({ error: "secret body" }, 403)) as unknown as typeof fetch)
		await expect(client.panels()).rejects.toThrow("HTTP 403")
		await expect(client.panels()).rejects.not.toThrow("secret body")
	})
	it("marks transformed panels unsupported and refuses non-Prometheus backends", async () => {
		const transformed = structuredClone(dashboard)
		Object.assign(transformed.dashboard.panels[0], { transformations: [{ id: "reduce" }] })
		const client = new GrafanaClient(config, "fixture", (async (url) =>
			String(url).includes("/dashboards/") ? json(transformed) : json({ type: "influxdb" })) as typeof fetch)
		expect((await client.panels())[0].problem).toContain("transformations")
		const result = await client.metrics("build", "1h")
		expect(result.results[0].error).toContain("transformations")
		expect(result.results[2].error).toContain("Prometheus")
	})
	it("keeps missing load and disk data empty instead of inventing zero", async () => {
		const empty = new GrafanaClient(config, "fixture", (async (url) =>
			String(url).includes("/dashboards/")
				? json(dashboard)
				: String(url).includes("/datasources/")
					? json({ type: "prometheus" })
					: json({ results: { Q0: { frames: [] } } })) as typeof fetch)
		const result = await empty.metrics("missing-host", "30d")
		expect(result.results[0].series).toEqual([])
		expect(result.results[2].series).toEqual([])
	})
})

describe("Grafana frame decoding and sample statistics", () => {
	it("preserves zero, gaps, per-device labels and byte values", () => {
		const [series] = decodeFrame(frame([0, null, 1024]), "bytes")
		expect(series.labels.volume).toBe("C:")
		expect(series.points.map((p) => p.value)).toEqual([0, null, 1024])
		const summary = metricSummary(series, 1000, 3000, 1000)
		expect(summary).toMatchObject({ average: 512, peak: 1024, p95: 1024, coverage: 2 / 3 })
	})
	it("separates table rows by device and retains hardware details", () => {
		const series = decodeFrame(
			{
				schema: {
					fields: [
						{ name: "Time", type: "time" },
						{ name: "Value", type: "number" },
						{ name: "model", type: "string" },
					],
				},
				data: {
					values: [
						[1000, 1000],
						[1, 1],
						["GPU A", "GPU B"],
					],
				},
			},
			"",
		)
		expect(series.map((s) => s.labels.model)).toEqual(["GPU A", "GPU B"])
	})
	it("does not turn non-finite or missing values into zero", () => {
		const [series] = decodeFrame(frame([NaN, Infinity, "42"]), "percent")
		expect(series.points.map((p) => p.value)).toEqual([null, null, null])
		expect(metricSummary(series, 1000, 3000, 1000)).toBeUndefined()
	})
})
