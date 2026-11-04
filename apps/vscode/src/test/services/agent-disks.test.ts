import { afterEach, describe, expect, it } from "bun:test"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { AgentDiskReader, diskCollectionKey, parseAgentDisk } from "@/services/devops-mcp/agents/agent-disks"
import { AgentMonitor, describeAgentStatusChange, validateAgentMonitorConfig } from "@/services/devops-mcp/agents/agent-monitor"
import { DEFAULT_AGENT_MONITOR_CONFIG, type MonitoredAgent } from "@/shared/agent-monitor"

const collection = "https://server.example/tfs/Collection"
const key = diskCollectionKey(collection)
const config = {
	...DEFAULT_AGENT_MONITOR_CONFIG,
	queueUrl: `${collection}/Project/_settings/agentqueues?queueId=21&view=agents`,
	enabled: true,
}
const worker: MonitoredAgent = {
	id: 7,
	name: "worker",
	status: "online",
	enabled: true,
	busy: false,
	capabilities: ["BUILD_CPU"],
	url: "",
	jobName: "",
	jobUrl: "",
}
const folders: string[] = []
const monitors: AgentMonitor[] = []
afterEach(async () => {
	for (const monitor of monitors.splice(0)) monitor.dispose()
	for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true })
})

describe("agent working-disk monitoring", () => {
	it("collects the actual working filesystem and reads the same contract without copying settings or credentials", async () => {
		const root = await mkdtemp(path.join(os.tmpdir(), "pliny-disk-test-"))
		folders.push(root)
		await mkdir(path.join(root, "_work"))
		const output = path.join(root, "metrics")
		await writeFile(
			path.join(root, ".agent"),
			JSON.stringify({
				serverUrl: `${collection}/`,
				agentId: 7,
				poolId: 99,
				workFolder: "_work",
				unrelatedSecret: "do-not-collect",
			}),
		)
		await writeFile(path.join(root, ".credentials"), "never-read-this")
		const collector = path.resolve(import.meta.dir, "../../../assets/agent-monitor/collect-disk.mjs")
		await promisify(execFile)("node", [collector, "--agent-root", root, "--output", output, "--once"], { timeout: 15_000 })
		const names = await readdir(output)
		expect(names).toEqual([`${key}-99-7.json`])
		const raw = await readFile(path.join(output, names[0]), "utf8")
		expect(raw).not.toContain("do-not-collect")
		expect(raw).not.toContain("never-read-this")
		expect(raw).not.toContain("server.example")
		const settings = { ...config, diskMetricsFolder: output }
		const pool = { poolName: "pool", poolId: 99, agents: [worker] }
		const result = await new AgentDiskReader().enrich(pool, settings)
		expect(result.agents[0].diskError).toBe("")
		expect(result.agents[0].disk?.totalBytes).toBeGreaterThan(0)
		expect(result.agents[0].disk?.freeBytes).toBeGreaterThanOrEqual(0)
		expect(result.agents[0].disk?.path).toContain("_work")
		await promisify(execFile)("node", [collector, "--agent-root", root, "--output", output, "--once"], { timeout: 15_000 })
		expect(await readdir(output)).toEqual(names)
		const refreshed = await readFile(path.join(output, names[0]), "utf8")
		expect(JSON.parse(refreshed).collectedAt).toBeGreaterThan(JSON.parse(raw).collectedAt)
		await writeFile(
			path.join(root, ".agent"),
			JSON.stringify({ serverUrl: collection, agentId: 7, poolId: 99, workFolder: "missing-folder" }),
		)
		await expect(
			promisify(execFile)("node", [collector, "--agent-root", root, "--output", output, "--once"], { timeout: 15_000 }),
		).rejects.toThrow()
		expect(await readFile(path.join(output, names[0]), "utf8")).toBe(refreshed)
		await writeFile(path.join(output, names[0]), "x".repeat(9000))
		const failed = await new AgentDiskReader().enrich(pool, settings)
		expect(failed.agents[0].status).toBe("online")
		expect(failed.agents[0].diskError).toContain("unavailable")
		expect(failed.agents[0].disk).toBeUndefined()
	}, 20_000)

	it("rejects mismatched identities, invalid capacity and future timestamps; allows old readings to be shown as stale", () => {
		const now = Date.now()
		const reading = {
			schemaVersion: 1,
			collection: key,
			poolId: 99,
			agentId: 7,
			path: "/build/_work",
			freeBytes: 30,
			totalBytes: 100,
			collectedAt: now - 600_000,
		}
		expect(parseAgentDisk(JSON.stringify(reading), key, 99, 7, now).freeBytes).toBe(30)
		for (const invalid of [
			{ collection: "other" },
			{ poolId: 1 },
			{ agentId: 8 },
			{ freeBytes: -1 },
			{ freeBytes: 101 },
			{ totalBytes: 0 },
			{ collectedAt: now + 120_000 },
			{ path: "\nsecret" },
		]) {
			expect(() => parseAgentDisk(JSON.stringify({ ...reading, ...invalid }), key, 99, 7, now)).toThrow()
		}
		expect(diskCollectionKey(`${collection.toUpperCase()}/`)).toBe(key)
	})

	it("degrades failed disk reads independently and leaves capability-filtered agents untouched", async () => {
		const result = await new AgentDiskReader(async () => {
			throw new Error("share offline")
		}).enrich(
			{ poolName: "pool", poolId: 99, agents: [worker, { ...worker, id: 8, capabilities: ["OTHER"] }] },
			{ ...config, diskMetricsFolder: os.tmpdir() },
		)
		expect(result.agents[0].status).toBe("online")
		expect(result.agents[0].diskError).toContain("unavailable")
		expect(result.agents[1].diskError).toBeUndefined()
	})

	it("validates local folder paths and ordered warning/critical thresholds without changing old configurations", () => {
		expect(validateAgentMonitorConfig(config)).toEqual(config)
		expect(() => validateAgentMonitorConfig({ ...config, diskMetricsFolder: "relative/path" })).toThrow("absolute")
		expect(() =>
			validateAgentMonitorConfig({
				...config,
				diskMetricsFolder: os.tmpdir(),
				diskWarningPercent: 10,
				diskCriticalPercent: 20,
			}),
		).toThrow("thresholds")
		expect(validateAgentMonitorConfig({ ...config, diskMetricsFolder: os.tmpdir() })).toMatchObject({
			diskWarningPercent: 20,
			diskCriticalPercent: 10,
		})
	})

	it("alerts once on fresh low-space/recovery transitions and preserves last-known data through a disk failure", async () => {
		let now = Date.now()
		let free = 30
		let failed = false
		const notifications: string[] = []
		const monitor = new AgentMonitor(
			{
				now: () => now,
				read: async () => ({
					poolName: "pool",
					agents: [
						{
							...worker,
							disk: failed ? undefined : { path: "/work", freeBytes: free, totalBytes: 100, collectedAt: now },
							diskError: failed ? "unavailable" : "",
						},
					],
				}),
				notify: (changes) => notifications.push(...changes.map(describeAgentStatusChange)),
			},
			{ ...config, notify: false, diskMetricsFolder: os.tmpdir(), diskNotify: true },
		)
		monitors.push(monitor)
		await monitor.refresh()
		free = 15
		now += 60_000
		await monitor.refresh()
		expect(notifications).toHaveLength(1)
		expect(notifications[0]).toContain("space low: 15.0%")
		now += 60_000
		await monitor.refresh()
		expect(notifications).toHaveLength(1)
		free = 30
		now += 60_000
		await monitor.refresh()
		expect(notifications[1]).toContain("recovered: 30.0%")
		failed = true
		now += 60_000
		await monitor.refresh()
		expect(monitor.view().error).toBe("")
		expect(monitor.view().agents[0].disk?.freeBytes).toBe(30)
		expect(monitor.view().agents[0].diskError).toBe("unavailable")
		failed = false
		free = 5
		now += 600_000
		await monitor.refresh()
		expect(notifications).toHaveLength(2)
	})
})
