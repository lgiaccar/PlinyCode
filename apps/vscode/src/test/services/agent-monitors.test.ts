import { afterEach, describe, expect, it } from "bun:test"
import { AgentMonitors, initialAgentPools } from "@/services/devops-mcp/agents/agent-monitors"
import type { AgentPoolSnapshot } from "@/services/devops-mcp/agents/agent-source"
import { DEFAULT_AGENT_MONITOR_CONFIG, type MonitoredAgent } from "@/shared/agent-monitor"

const config = {
	...DEFAULT_AGENT_MONITOR_CONFIG,
	queueUrl: "https://server.example/collection/project/_settings/agentqueues?queueId=1&view=agents",
	enabled: true,
}
const second = { ...config, queueUrl: config.queueUrl.replace("queueId=1", "queueId=2") }
const agent: MonitoredAgent = {
	id: 1,
	name: "worker",
	status: "online",
	enabled: true,
	busy: false,
	capabilities: ["BUILD_CPU"],
	url: "",
	jobName: "",
	jobUrl: "",
}
const monitors: AgentMonitors[] = []
afterEach(() => {
	for (const monitor of monitors.splice(0)) monitor.dispose()
})

describe("multiple agent pools", () => {
	it("migrates existing workspace settings and respects removed pools after restart", () => {
		const legacy = { workspace: config }
		expect(initialAgentPools({}, legacy, "workspace", "", "pat")).toEqual([{ id: "default", config }])
		expect(initialAgentPools({ workspace: [] }, legacy, "workspace", "", "pat")).toEqual([])
		const saved = [{ id: "two", config: second }]
		expect(initialAgentPools({ workspace: saved }, legacy, "workspace", "", "pat")).toEqual(saved)
		expect(initialAgentPools({}, legacy, "new", "", "pat")[0].config).toMatchObject({
			queueUrl: config.queueUrl,
			enabled: false,
			authentication: "pat",
		})
	})
	it("polls independently and keeps notification baselines separate even when agent IDs coincide", async () => {
		let release!: (value: AgentPoolSnapshot) => void
		let slow = true
		let failed = false
		let status: MonitoredAgent["status"] = "online"
		const changes: string[] = []
		const monitor = new AgentMonitors(
			{
				read: async (settings) => {
					if (settings.queueUrl === config.queueUrl) {
						if (slow)
							return new Promise((resolve) => {
								release = resolve
							})
						if (failed) throw new Error("First pool unreachable")
						return { poolName: "First", agents: [agent] }
					}
					return { poolName: "Second", agents: [{ ...agent, status }] }
				},
				notify: (pool) => changes.push(pool),
			},
			[
				{ id: "one", config },
				{ id: "two", config: second },
			],
		)
		monitors.push(monitor)
		const polling = monitor.refresh()
		await monitor.refresh("two")
		expect(monitor.view().pools[1].poolName).toBe("Second")
		expect(monitor.view().pools[0].refreshing).toBe(true)
		expect(changes).toEqual([])
		release({ poolName: "First", agents: [agent] })
		await polling
		slow = false
		failed = true
		status = "offline"
		await monitor.refresh()
		expect(monitor.view().pools[0]).toMatchObject({ error: "First pool unreachable", agents: [agent] })
		expect(monitor.view().pools[1].agents[0].status).toBe("offline")
		expect(changes).toEqual(["Second"])
		monitor.configure("one", { ...config, enabled: false })
		status = "online"
		await monitor.refresh("two")
		expect(changes).toEqual(["Second", "Second"])
	})
	it("adds, deduplicates, saves, and removes pools without applying late results", async () => {
		let release!: (value: AgentPoolSnapshot) => void
		const monitor = new AgentMonitors(
			{
				read: () =>
					new Promise((resolve) => {
						release = resolve
					}),
				notify: () => {},
			},
			[],
		)
		monitors.push(monitor)
		const id = monitor.configure("", config)
		const pending = monitor.refresh(id)
		expect(() => monitor.configure("", { ...config, queueUrl: config.queueUrl.replace("&view=agents", "") })).toThrow(
			"already saved",
		)
		expect(monitor.configs()).toEqual([{ id, config }])
		monitor.remove(id)
		release({ poolName: "Removed", agents: [agent] })
		await pending
		expect(monitor.view().pools).toEqual([])
		expect(monitor.configs()).toEqual([])
		expect(() => monitor.configure(id, config)).toThrow("removed")
		await expect(monitor.refresh(id)).rejects.toThrow("removed")
	})
})
