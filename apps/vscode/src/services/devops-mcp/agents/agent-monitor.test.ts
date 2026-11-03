import { afterEach, describe, expect, it } from "bun:test"
import { type AgentMonitorConfig, DEFAULT_AGENT_MONITOR_CONFIG, type MonitoredAgent } from "@/shared/agent-monitor"
import {
	AgentMonitor,
	type AgentStatusChange,
	describeAgentStatusChange,
	initialAgentMonitorConfig,
	validateAgentMonitorConfig,
} from "./agent-monitor"
import { agentQueueTarget, readAgentPool } from "./agent-source"

const url = "https://server.example/tfs/Collection/My%20Project/_settings/agentqueues?queueId=21&view=agents"
const config: AgentMonitorConfig = { ...DEFAULT_AGENT_MONITOR_CONFIG, queueUrl: url, enabled: true }
const agent = (id: number, status: MonitoredAgent["status"], capabilities = ["FFI_BUILD_WIN"]): MonitoredAgent => ({
	id,
	name: `agent-${id}`,
	status,
	capabilities,
	enabled: true,
	busy: false,
	url,
	jobName: "",
	jobUrl: "",
})
const monitors: AgentMonitor[] = []
afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.dispose()
})
const monitorWith = (
	read: ConstructorParameters<typeof AgentMonitor>[0]["read"],
	notify = (_changes: AgentStatusChange[]) => {},
) => {
	const monitor = new AgentMonitor({ read, notify, now: () => 1234 }, config)
	monitors.push(monitor)
	return monitor
}

describe("agent pool monitor", () => {
	it("offers local defaults for new workspaces without replacing saved workspace settings", () => {
		const otherUrl = url.replace("queueId=21", "queueId=22")
		expect(initialAgentMonitorConfig({}, "new", "", "windows").queueUrl).toBe("")
		expect(initialAgentMonitorConfig({ old: config }, "new", "", "windows")).toMatchObject({ queueUrl: url, enabled: false })
		expect(initialAgentMonitorConfig({ old: config }, "new", otherUrl, "pat")).toMatchObject({
			queueUrl: otherUrl,
			authentication: "pat",
			enabled: false,
		})
		expect(initialAgentMonitorConfig({ old: config }, "old", otherUrl, "pat")).toEqual(config)
		expect(
			initialAgentMonitorConfig({ old: config, other: { ...config, queueUrl: otherUrl } }, "new", "", "windows").queueUrl,
		).toBe("")
		expect(initialAgentMonitorConfig({}, "new", "invalid", "windows").queueUrl).toBe("")
	})
	it("resolves an on-premises project URL without confusing queue and pool IDs", () => {
		const target = agentQueueTarget(url)
		expect(target.collectionUrl).toBe("https://server.example/tfs/Collection")
		expect(target.queueApi).toBe(
			"https://server.example/tfs/Collection/My%20Project/_apis/distributedtask/queues/21?api-version=7.1",
		)
		expect(target.remote.collection).toBe("tfs/Collection")
		expect(agentQueueTarget("https://dev.azure.com/org/project/_settings/agentqueues?queueId=7").collectionUrl).toBe(
			"https://dev.azure.com/org",
		)
	})
	it("rejects unsafe targets and unsupported patterns before making requests", () => {
		for (const invalid of [
			url.replace("https:", "http:"),
			url.replace("server.example", "user:secret@server.example"),
			url.replace("queueId=21", "queueId=-1"),
			"https://server.example/",
		]) {
			expect(() => agentQueueTarget(invalid)).toThrow()
		}
		expect(() => validateAgentMonitorConfig({ ...config, capabilities: ["FFI_*_WIN"] })).toThrow("prefix ending")
		expect(() => validateAgentMonitorConfig({ ...config, queueUrl: "" })).toThrow("Enter an agent-pool")
	})
	it("matches any exact or prefix capability and excludes unrelated capability names", async () => {
		const monitor = monitorWith(async () => ({
			poolName: "pool",
			agents: [
				agent(1, "online", ["FFI_BUILD_R8", "SECRET_ENV"]),
				agent(2, "offline", ["PERFORMANCE"]),
				agent(3, "online", ["OTHER"]),
			],
		}))
		await monitor.refresh()
		expect(monitor.view()).toMatchObject({ total: 3, updated: 1234, error: "" })
		expect(monitor.view().agents.map((a) => a.id)).toEqual([1, 2])
		expect(monitor.view().agents[0].capabilities).toEqual(["FFI_BUILD_R8"])
	})
	it("preserves the last successful snapshot on a connection failure, and notifies only transitions", async () => {
		let status: MonitoredAgent["status"] = "online"
		let fail = false
		const changes: string[] = []
		const monitor = monitorWith(
			async () => {
				if (fail) throw new Error("Connection lost")
				return { poolName: "pool", agents: [agent(1, status)] }
			},
			(agents) => changes.push(...agents.map((a) => a.after.status)),
		)
		await monitor.refresh()
		await monitor.refresh()
		expect(changes).toEqual([])
		fail = true
		await monitor.refresh()
		expect(monitor.view()).toMatchObject({ error: "Connection lost", updated: 1234 })
		expect(monitor.view().agents[0].status).toBe("online")
		expect(changes).toEqual([])
		fail = false
		status = "offline"
		await monitor.refresh()
		await monitor.refresh()
		status = "online"
		await monitor.refresh()
		expect(changes).toEqual(["offline", "online"])
	})
	it("notifies connection changes on disabled agents, but not unknown status or first observations", async () => {
		let agents = [agent(1, "offline"), { ...agent(2, "online"), enabled: false }, agent(3, "unknown")]
		const changes: AgentStatusChange[] = []
		const monitor = monitorWith(
			async () => ({ poolName: "pool", agents }),
			(a) => changes.push(...a),
		)
		await monitor.refresh()
		expect(changes).toEqual([])
		agents = [agent(1, "unknown"), { ...agent(2, "offline"), enabled: false }, agent(3, "online")]
		await monitor.refresh()
		expect(changes.map(describeAgentStatusChange)).toEqual(["agent-2: online → offline"])
	})
	it("reports enabled and disabled transitions once, including simultaneous connection changes", async () => {
		let current = agent(1, "online")
		const changes: AgentStatusChange[] = []
		const monitor = monitorWith(
			async () => ({ poolName: "pool", agents: [current] }),
			(items) => changes.push(...items),
		)
		await monitor.refresh()
		current = { ...current, enabled: false }
		await monitor.refresh()
		await monitor.refresh()
		current = { ...current, enabled: true, status: "offline" }
		await monitor.refresh()
		current = { ...current, status: "unknown" }
		await monitor.refresh()
		current = { ...current, enabled: false }
		await monitor.refresh()
		expect(changes.map(describeAgentStatusChange)).toEqual([
			"agent-1: enabled → disabled",
			"agent-1: online → offline, disabled → enabled",
			"agent-1: enabled → disabled",
		])
		monitor.configure({ ...config, notify: false })
		await monitor.refresh()
		current = { ...current, enabled: true, status: "online" }
		await monitor.refresh()
		expect(changes).toHaveLength(3)
	})
	it("coalesces concurrent refreshes and discards a stopped monitor's in-flight result", async () => {
		let release!: (pool: { poolName: string; agents: MonitoredAgent[] }) => void
		let calls = 0
		const monitor = monitorWith(() => {
			calls++
			return new Promise((resolve) => {
				release = resolve
			})
		})
		const first = monitor.refresh()
		const second = monitor.refresh()
		expect(calls).toBe(1)
		monitor.configure({ ...config, enabled: false })
		release({ poolName: "old", agents: [agent(1, "online")] })
		await Promise.all([first, second])
		expect(monitor.view()).toMatchObject({ poolName: "", agents: [], updated: 0, refreshing: false })
		await monitor.refresh()
		expect(calls).toBe(1)
	})
	it("loads a newly selected queue after an obsolete request completes", async () => {
		let release!: (pool: { poolName: string; agents: MonitoredAgent[] }) => void
		let calls = 0
		const monitor = monitorWith(() =>
			++calls === 1
				? new Promise((resolve) => {
						release = resolve
					})
				: Promise.resolve({ poolName: "new", agents: [agent(2, "online")] }),
		)
		const first = monitor.refresh()
		monitor.configure({ ...config, queueUrl: url.replace("queueId=21", "queueId=22") })
		release({ poolName: "old", agents: [agent(1, "online")] })
		await first
		await monitor.refresh()
		expect(monitor.view().poolName).toBe("new")
		expect(monitor.view().agents.map((a) => a.id)).toEqual([2])
	})
	it("disposal prevents late results and notifications", async () => {
		let release!: (pool: { poolName: string; agents: MonitoredAgent[] }) => void
		const monitor = monitorWith(
			() =>
				new Promise((resolve) => {
					release = resolve
				}),
		)
		const pending = monitor.refresh()
		monitor.dispose()
		release({ poolName: "pool", agents: [agent(1, "online")] })
		await pending
		expect(monitor.view().updated).toBe(0)
	})
})

describe("PAT agent transport", () => {
	it("resolves the pool, includes current jobs, strips capability values and unsafe job links", async () => {
		const original = globalThis.fetch
		const requests: { url: string; init?: RequestInit }[] = []
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), init })
			return Response.json(
				requests.length === 1
					? { pool: { id: 99, name: "pool" } }
					: {
							value: [
								{
									id: 1,
									name: "worker",
									status: "unexpected",
									enabled: true,
									systemCapabilities: { FFI_BUILD_R8: "True", SECRET: "never expose" },
									userCapabilities: { PERFORMANCE: "True" },
									assignedRequest: {
										owner: { name: "build", _links: { web: { href: "https://other.example/job" } } },
									},
								},
							],
						},
			)
		}) as typeof fetch
		try {
			const result = await readAgentPool({ ...config, authentication: "pat" }, async () => "test-token")
			expect(requests[1].url).toContain("/pools/99/agents?")
			expect(requests[1].url).toContain("includeAssignedRequest=true")
			expect(requests.every((r) => r.init?.redirect === "error")).toBe(true)
			expect(result.agents[0]).toMatchObject({
				status: "unknown",
				busy: true,
				jobUrl: "",
				capabilities: ["FFI_BUILD_R8", "PERFORMANCE", "SECRET"],
			})
			expect(JSON.stringify(result)).not.toContain("never expose")
		} finally {
			globalThis.fetch = original
		}
	})
})
