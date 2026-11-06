import {
	type GrafanaConfig,
	type GrafanaPanelChoice,
	type GrafanaSetup,
	MACHINE_METRICS,
	type MachineMetric,
	type MachineMetrics,
	type MachineSeries,
	METRIC_LABELS,
	METRIC_RANGES,
	type MetricRange,
} from "@shared/grafana-metrics"
import { z } from "zod"

const sourceSchema = z.union([z.string(), z.object({ uid: z.string().nullish(), type: z.string().optional() })])
const targetSchema = z.object({
	expr: z.string().optional(),
	refId: z.string().default("A"),
	hide: z.boolean().optional(),
	datasource: sourceSchema.nullish(),
	legendFormat: z.string().optional(),
	interval: z.string().optional(),
})
const panelSchema = z.object({
	id: z.number().int(),
	title: z.string().default("Untitled panel"),
	type: z.string().optional(),
	datasource: sourceSchema.nullish(),
	targets: z.array(targetSchema).default([]),
	transformations: z.array(z.unknown()).optional(),
	fieldConfig: z
		.object({ defaults: z.object({ unit: z.string().optional() }).optional(), overrides: z.array(z.unknown()).optional() })
		.optional(),
})
type Panel = z.infer<typeof panelSchema> & { parseProblem?: string }
const dashboardSchema = z.object({
	dashboard: z.object({
		panels: z.array(z.unknown()),
		templating: z
			.object({
				list: z.array(
					z.object({
						name: z.string(),
						type: z.string(),
						current: z.object({ value: z.union([z.string(), z.array(z.string())]) }).optional(),
					}),
				),
			})
			.optional(),
	}),
})
type Dashboard = z.infer<typeof dashboardSchema>["dashboard"]
const frameSchema = z.object({
	schema: z.object({
		name: z.string().optional(),
		fields: z.array(z.object({ name: z.string(), type: z.string(), labels: z.record(z.string(), z.string()).optional() })),
	}),
	data: z.object({ values: z.array(z.array(z.unknown())) }),
})
const querySchema = z.object({
	results: z.record(
		z.string(),
		z.object({ error: z.string().optional(), status: z.number().optional(), frames: z.array(frameSchema).optional() }),
	),
})

export function validateGrafanaConfig(input: GrafanaConfig, allowDiscovery = false): GrafanaConfig {
	if (
		!input ||
		typeof input.url !== "string" ||
		typeof input.dashboardUid !== "string" ||
		typeof input.hostVariable !== "string"
	)
		throw new Error("Enter a Grafana server URL, dashboard UID and host variable.")
	let url: URL
	try {
		url = new URL(input.url.trim())
	} catch {
		throw new Error("Enter the Grafana server URL.")
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("Use an HTTP(S) Grafana server URL without credentials, query parameters or a fragment.")
	if (!(allowDiscovery && !input.dashboardUid) && !/^[\w-]{1,128}$/.test(input.dashboardUid))
		throw new Error("Enter the dashboard UID from its /d/UID/ URL.")
	if (!/^[a-zA-Z][\w]{0,63}$/.test(input.hostVariable)) throw new Error("Enter the dashboard's host variable name.")
	const panels: GrafanaConfig["panels"] = {}
	for (const kind of MACHINE_METRICS) {
		const id = input.panels?.[kind]
		if (id !== undefined) {
			if (!Number.isSafeInteger(id) || id < 1) throw new Error("Select a valid dashboard panel.")
			panels[kind] = id
		}
	}
	return { url: url.href.replace(/\/$/, ""), dashboardUid: input.dashboardUid, hostVariable: input.hostVariable, panels }
}

/** Hostnames are literal single hosts, not query fragments, regexes or Grafana's All value. */
export function validateMetricHost(host: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(host))
		throw new Error("Enter a single Grafana hostname or instance (optionally including its port).")
	return host
}

export function interpolatePromQuery(
	expr: string,
	variable: string,
	host: string,
	rangeMs: number,
	stepMs: number,
	scrapeMs = 15_000,
): string {
	validateMetricHost(host)
	const token = `(?:\\$${variable}\\b|\\$\\{${variable}(?::regex)?\\})`
	const matcher = new RegExp(`(?<!!)(=~|=)\\s*"${token}"`, "g")
	let matched = false
	let query = expr.replace(matcher, (_, operator: string) => {
		matched = true
		const literal = operator === "=~" ? host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : host
		return `${operator}${JSON.stringify(literal)}`
	})
	if (!matched) throw new Error("The panel must filter one host using the configured variable in a positive label matcher.")
	const macros: Record<string, string> = {
		__interval: `${stepMs / 1000}s`,
		__interval_ms: String(stepMs),
		__rate_interval: `${Math.max(4 * scrapeMs, stepMs + scrapeMs) / 1000}s`,
		__range: `${rangeMs / 1000}s`,
		__range_s: String(rangeMs / 1000),
		__range_ms: String(rangeMs),
	}
	query = query.replace(/\$(\w+)|\$\{(\w+)\}/g, (whole, a, b) => macros[a ?? b] ?? whole)
	if (/\$[\w{]/.test(query))
		throw new Error("The panel uses additional dashboard variables. Use a panel with only the host and time-range variables.")
	return query
}

function intervalMs(value: unknown): number {
	if (!value || value === "$__interval") return 15_000
	const match = typeof value === "string" && /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(value)
	if (!match) throw new Error("This datasource or query has an unsupported scrape interval.")
	const result = Number(match[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2]] ?? 0)
	if (!result) throw new Error("The scrape interval must be positive.")
	return result
}

function flattenPanels(values: unknown[]): Panel[] {
	const result: Panel[] = []
	for (const value of values) {
		const parsed = panelSchema.safeParse(value)
		if (parsed.success && parsed.data.targets.length) result.push(parsed.data)
		if (!parsed.success) {
			const identity = z.object({ id: z.number().int(), title: z.string(), targets: z.array(z.unknown()) }).safeParse(value)
			if (identity.success && identity.data.targets.length)
				result.push({
					id: identity.data.id,
					title: identity.data.title,
					targets: [],
					parseProblem: "Unsupported dashboard panel format.",
				})
		}
		if (value && typeof value === "object" && "panels" in value && Array.isArray(value.panels))
			result.push(...flattenPanels(value.panels))
	}
	return result
}
function panelProblem(panel: Panel): string {
	if (panel.parseProblem) return panel.parseProblem
	if (panel.transformations?.length) return "Panel transformations are not supported; select an untransformed source panel."
	if (panel.fieldConfig?.overrides?.length) return "Panel field overrides are not supported; select a panel with a common unit."
	if (!panel.targets.some((target) => !target.hide && target.expr)) return "This panel has no Prometheus query."
	if (panel.targets.filter((t) => !t.hide).length > 8) return "This panel has more than eight queries."
	return ""
}

/** Select by panel semantics and units; never turn used disk space into free space. */
function discoverMapping(panels: Panel[]): Pick<GrafanaConfig, "panels" | "hostVariable"> | undefined {
	const candidates: { kind: MachineMetric; panel: Panel; variable: string; score: number }[] = []
	for (const panel of panels) {
		if (panelProblem(panel)) continue
		const targets = panel.targets.filter((target) => !target.hide)
		if (
			targets.some((target) => {
				const source = target.datasource ?? panel.datasource
				return source && typeof source === "object" && source.type && source.type !== "prometheus"
			})
		)
			continue
		const variables = new Set<string>()
		for (const target of targets) {
			for (const match of (target.expr ?? "").matchAll(
				/\b([a-zA-Z_]\w*)\s*(?:=~|=)\s*"(?:\$(\w+)|\$\{(\w+)(?::regex)?\})"/g,
			)) {
				const variable = match[2] ?? match[3]
				const hostName =
					/^(?:exported_)?(?:host|hostname|instance|computer|machine|node|nodename|server|agent)(?:_name)?$/i
				if (hostName.test(match[1]) || hostName.test(variable)) variables.add(variable)
			}
		}
		if (variables.size !== 1) continue
		const variable = [...variables][0]
		if (!/^[a-zA-Z][\w]{0,63}$/.test(variable)) continue
		try {
			for (const target of targets) interpolatePromQuery(target.expr ?? "", variable, "discovery-host", 3600000, 15000)
		} catch {
			continue
		}
		const title = panel.title.toLowerCase()
		const unit = panel.fieldConfig?.defaults?.unit ?? ""
		const gpu = /\bgpu\b|graphics|cuda|nvidia/.test(title)
		const cpu = !gpu && /\bcpu\b|processor/.test(title)
		let kind: MachineMetric | undefined
		if (["percent", "percentunit"].includes(unit) && !/memory|ram|temperature|power|disk/.test(title)) {
			if (cpu) kind = "cpu"
			if (gpu) kind = "gpu"
		} else if (
			["bytes", "decbytes"].includes(unit) &&
			/disk|filesystem|volume|storage/.test(title) &&
			/free|avail/.test(title) &&
			!/\bused\b/.test(title)
		) {
			kind = "disk"
		} else if (!/percent|celsius|fahrenheit|watt/.test(unit)) {
			if (gpu && /info|model|device|characteristic|vram|driver/.test(title)) kind = "gpuInfo"
			if (
				(cpu && /info|model|characteristic|cores|threads|sockets/.test(title)) ||
				/^(cores|threads|sockets)$/.test(title.trim())
			)
				kind = "cpuInfo"
		}
		if (!kind) continue
		const score =
			10 +
			(panel.type === "timeseries" && (kind === "cpu" || kind === "gpu") ? 4 : 0) -
			(/\bnow\b|current/.test(title) && (kind === "cpu" || kind === "gpu") ? 2 : 0)
		candidates.push({ kind, panel, variable, score })
	}
	const groups = new Map<string, GrafanaConfig["panels"]>()
	for (const variable of new Set(candidates.map((item) => item.variable))) {
		const selected: GrafanaConfig["panels"] = {}
		for (const kind of MACHINE_METRICS) {
			const matches = candidates
				.filter((item) => item.variable === variable && item.kind === kind)
				.sort((a, b) => b.score - a.score)
			if (matches.length && (matches.length === 1 || matches[0].score > matches[1].score))
				selected[kind] = matches[0].panel.id
		}
		if (selected.cpu || selected.gpu || selected.disk) groups.set(variable, selected)
	}
	if (groups.size !== 1) return undefined
	const [hostVariable, selected] = [...groups][0]
	return { hostVariable, panels: selected }
}

/** No browser cookies, datasource credentials or remote error bodies enter the webview/logs. */
export class GrafanaClient {
	constructor(
		private readonly config: GrafanaConfig,
		private readonly token: string,
		private readonly request: typeof fetch = fetch,
	) {}
	private async json(path: string, body?: unknown): Promise<unknown> {
		let response: Response
		try {
			response = await this.request(`${this.config.url}${path}`, {
				method: body ? "POST" : "GET",
				headers: {
					Authorization: `Bearer ${this.token}`,
					Accept: "application/json",
					...(body ? { "Content-Type": "application/json" } : {}),
				},
				body: body ? JSON.stringify(body) : undefined,
				redirect: "error",
				signal: AbortSignal.timeout(20_000),
			})
		} catch {
			throw new Error(
				"Grafana request failed or timed out. Check network access and the server URL; redirects are not followed.",
			)
		}
		if (!response.ok) {
			await response.body?.cancel()
			throw new Error(
				`Grafana returned HTTP ${response.status}.${response.status === 401 || response.status === 403 ? " Check the token's dashboard-read and datasource-query permissions." : ""}`,
			)
		}
		if (!response.headers.get("content-type")?.includes("json")) {
			await response.body?.cancel()
			throw new Error("Grafana returned a non-JSON response. Check the server URL and sign-in requirements.")
		}
		const reader = response.body?.getReader()
		if (!reader) throw new Error("Grafana returned an empty response.")
		const chunks: Uint8Array[] = []
		let size = 0
		try {
			while (true) {
				const { done, value } = await reader.read()
				if (done) break
				size += value.length
				if (size > 8 * 1024 * 1024) throw new Error("Grafana response is too large. Choose a smaller panel.")
				chunks.push(value)
			}
			return JSON.parse(Buffer.concat(chunks).toString("utf8"))
		} catch {
			throw new Error("Grafana returned an invalid, oversized or interrupted response.")
		} finally {
			await reader.cancel().catch(() => {})
			reader.releaseLock()
		}
	}
	private async dashboard(uid = this.config.dashboardUid): Promise<Dashboard> {
		const result = dashboardSchema.safeParse(await this.json(`/api/dashboards/uid/${encodeURIComponent(uid)}`))
		if (!result.success) throw new Error("Grafana returned an unsupported dashboard format.")
		return result.data.dashboard
	}
	async panels(): Promise<GrafanaPanelChoice[]> {
		return flattenPanels((await this.dashboard()).panels).map((p) => ({
			id: p.id,
			title: p.title,
			unit: p.fieldConfig?.defaults?.unit ?? "",
			problem: panelProblem(p),
		}))
	}
	/** Discover only supported, host-scoped panels. Ties require an explicit choice. */
	async discover(): Promise<GrafanaSetup> {
		const candidate = async (uid: string) => {
			const dashboard = await this.dashboard(uid)
			const panels = flattenPanels(dashboard.panels)
			const mapping = discoverMapping(panels)
			if (!mapping) return undefined
			return {
				config: { ...this.config, dashboardUid: uid, hostVariable: mapping.hostVariable, panels: mapping.panels },
				hasToken: true,
				panels: panels.map((p) => ({
					id: p.id,
					title: p.title,
					unit: p.fieldConfig?.defaults?.unit ?? "",
					problem: panelProblem(p),
				})),
				score: Object.keys(mapping.panels).length,
			}
		}
		// An already selected dashboard takes precedence over unrelated fleet dashboards.
		if (this.config.dashboardUid) {
			try {
				const saved = await candidate(this.config.dashboardUid)
				if (saved) return saved
			} catch (error) {
				if (!(error instanceof Error) || !error.message.includes("HTTP 404")) throw error
			}
		}
		const search = z
			.array(z.object({ uid: z.string(), title: z.string() }))
			.safeParse(await this.json("/api/search?type=dash-db&limit=100"))
		if (!search.success) throw new Error("Grafana returned an unsupported dashboard list. Use Advanced setup.")
		const possible = search.data.filter((item) => /^[\w-]{1,128}$/.test(item.uid) && item.uid !== this.config.dashboardUid)
		const named = possible.filter((item) => /agent|machine|host|resource|node/i.test(item.title))
		const shortlist = named.length ? named : possible
		if (shortlist.length > 12 || search.data.length >= 100)
			throw new Error("Several dashboards are available. Select a dashboard in Advanced setup, then discover again.")
		const candidates: NonNullable<Awaited<ReturnType<typeof candidate>>>[] = []
		for (const item of shortlist) {
			const found = await candidate(item.uid)
			if (found) candidates.push(found)
		}
		candidates.sort((a, b) => b.score - a.score)
		if (!candidates.length)
			throw new Error("No matching machine panels found. Use Advanced setup to select your source panels.")
		if (candidates.length > 1 && candidates[0].score === candidates[1].score)
			throw new Error("More than one dashboard matches. Select a dashboard in Advanced setup, then discover again.")
		return candidates[0]
	}
	private defaultSource: Promise<string> | undefined
	private async sourceUid(source: z.infer<typeof sourceSchema> | null | undefined, dashboard: Dashboard): Promise<string> {
		if (source && typeof source === "object" && source.type && source.type !== "prometheus")
			throw new Error("This integration currently supports Prometheus datasources only.")
		let uid = typeof source === "string" ? source : source?.uid
		if (!uid) {
			this.defaultSource ??= this.json("/api/datasources").then((value) => {
				const parsed = z
					.array(z.object({ uid: z.string(), type: z.string(), isDefault: z.boolean().optional() }))
					.safeParse(value)
				const defaults = parsed.success ? parsed.data.filter((entry) => entry.isDefault) : []
				if (defaults.length !== 1 || defaults[0].type !== "prometheus")
					throw new Error(
						"This panel requires a default Prometheus datasource and permission to read datasource metadata.",
					)
				return defaults[0].uid
			})
			uid = await this.defaultSource
		}
		const variable = /^\$(\w+)$|^\$\{(\w+)\}$/.exec(uid ?? "")
		if (variable) {
			const entry = dashboard.templating?.list.find(
				(v) => v.name === (variable[1] ?? variable[2]) && v.type === "datasource",
			)
			uid = typeof entry?.current?.value === "string" ? entry.current.value : undefined
		}
		if (!uid || !/^[\w-]{1,128}$/.test(uid)) throw new Error("This panel needs an explicit Prometheus datasource UID.")
		return uid
	}
	async metrics(host: string, range: MetricRange, now = Date.now(), diskOnly = false): Promise<MachineMetrics> {
		validateMetricHost(host)
		const duration = METRIC_RANGES[range]
		if (!duration) throw new Error("Choose a supported time range.")
		const stepMs = Math.max(15_000, Math.ceil(duration / 600 / 1000) * 1000)
		const dashboard = await this.dashboard()
		const panels = flattenPanels(dashboard.panels)
		const sources = new Map<string, Promise<number>>()
		const results = await Promise.all(
			MACHINE_METRICS.filter((kind) => !diskOnly || kind === "disk").map(async (kind) => {
				const panel = panels.find((p) => p.id === this.config.panels[kind])
				const result = {
					kind,
					title: panel ? `${METRIC_LABELS[kind]} · ${panel.title}` : METRIC_LABELS[kind],
					series: [] as MachineSeries[],
					error: "",
				}
				if (!panel) return { ...result, error: "No dashboard panel selected." }
				try {
					const problem = panelProblem(panel)
					if (problem) throw new Error(problem)
					const unit = panel.fieldConfig?.defaults?.unit ?? ""
					if ((kind === "cpu" || kind === "gpu") && !["percent", "percentunit"].includes(unit))
						throw new Error("Select a load panel with percent (0–100) or percent (0–1) units.")
					if (kind === "disk" && !["bytes", "decbytes"].includes(unit))
						throw new Error("Select a free/available disk-space panel with byte units.")
					const queries = await Promise.all(
						panel.targets
							.filter((t) => !t.hide)
							.map(async (target, index) => {
								if (!target.expr) throw new Error("Only Prometheus expression queries are supported.")
								const uid = await this.sourceUid(target.datasource ?? panel.datasource, dashboard)
								if (!sources.has(uid))
									sources.set(
										uid,
										this.json(`/api/datasources/uid/${encodeURIComponent(uid)}`).then((source) => {
											if (
												!source ||
												typeof source !== "object" ||
												!("type" in source) ||
												source.type !== "prometheus"
											)
												throw new Error(
													"This integration currently supports Prometheus datasources only.",
												)
											const settings = z
												.object({
													jsonData: z.object({ timeInterval: z.string().optional() }).optional(),
												})
												.parse(source)
											return intervalMs(settings.jsonData?.timeInterval)
										}),
									)
								const sourceInterval = await sources.get(uid)
								const scrapeMs =
									target.interval && target.interval !== "$__interval"
										? intervalMs(target.interval)
										: (sourceInterval ?? 15_000)
								const queryStep = Math.max(stepMs, scrapeMs)
								return {
									refId: `Q${index}`,
									datasource: { uid, type: "prometheus" },
									expr: interpolatePromQuery(
										target.expr,
										this.config.hostVariable,
										host,
										duration,
										queryStep,
										scrapeMs,
									),
									intervalMs: queryStep,
									maxDataPoints: 600,
									range: kind === "cpu" || kind === "gpu",
									instant: kind !== "cpu" && kind !== "gpu",
									format: "time_series",
								}
							}),
					)
					const parsed = querySchema.safeParse(
						await this.json("/api/ds/query", { from: String(now - duration), to: String(now), queries }),
					)
					if (!parsed.success) throw new Error("Grafana returned unsupported query data.")
					for (const query of queries) {
						const data = parsed.data.results[query.refId]
						if (!data || data.error || (data.status && data.status >= 400))
							throw new Error("Grafana could not evaluate this panel. Check the query in Grafana.")
						for (const frame of data.frames ?? [])
							result.series.push(
								...decodeFrame(frame, unit).map((series) => ({ ...series, stepMs: query.intervalMs })),
							)
					}
					if (result.series.length > 64)
						throw new Error("This panel returns too many series. Limit it to this machine's CPUs, GPUs or disks.")
				} catch (error) {
					result.series = []
					result.error = error instanceof Error ? error.message : "Could not read this metric."
				}
				return result
			}),
		)
		return { host, from: now - duration, to: now, stepMs, results }
	}
}

export function decodeFrame(frame: z.infer<typeof frameSchema>, unit: string): MachineSeries[] {
	const fields = frame.schema.fields
	const times = frame.data.values[fields.findIndex((f) => f.type === "time")]
	if (!times) return []
	const strings = fields.map((field, index) => ({ field, index })).filter(({ field }) => field.type === "string")
	const output: MachineSeries[] = []
	for (let index = 0; index < fields.length; index++) {
		const field = fields[index]
		if (field.type !== "number") continue
		const groups = new Map<string, MachineSeries>()
		for (let row = 0; row < times.length; row++) {
			const time = times[row]
			if (typeof time !== "number" || !Number.isFinite(time)) continue
			const labels = { ...field.labels }
			for (const { field: labelField, index: labelIndex } of strings) {
				const value = frame.data.values[labelIndex]?.[row]
				if (typeof value === "string") labels[labelField.name] = value
			}
			const key = JSON.stringify(labels)
			let series = groups.get(key)
			if (!series) {
				series = {
					name: frame.schema.name || field.name,
					labels,
					unit: unit === "percentunit" ? "percent" : unit,
					points: [],
				}
				groups.set(key, series)
			}
			const raw = frame.data.values[index]?.[row]
			series.points.push({
				time,
				value: typeof raw === "number" && Number.isFinite(raw) ? raw * (unit === "percentunit" ? 100 : 1) : null,
			})
		}
		for (const series of groups.values()) {
			series.points.sort((a, b) => a.time - b.time)
			output.push(series)
		}
	}
	return output
}
