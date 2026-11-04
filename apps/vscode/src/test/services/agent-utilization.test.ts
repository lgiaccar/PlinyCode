import { describe, expect, it } from "bun:test"
import { AgentUtilization } from "@/services/devops-mcp/agents/agent-utilization"
import type { MonitoredAgent } from "@/shared/agent-monitor"

const minute = 60_000
const agent: MonitoredAgent = {
	id: 1,
	name: "worker",
	status: "online",
	enabled: true,
	busy: true,
	capabilities: [],
	url: "",
	jobName: "",
	jobUrl: "",
}
const usage = (tracker: AgentUtilization, at: number, changes: Partial<MonitoredAgent> = {}) =>
	tracker.observe([{ ...agent, ...changes }], at, 2 * minute)[0].utilization

describe("agent busy-time utilization", () => {
	it("weights elapsed time rather than refresh count and separates agent IDs", () => {
		const tracker = new AgentUtilization()
		expect(usage(tracker, minute)).toEqual({ busyMs: 0, observedMs: 0 })
		usage(tracker, 2 * minute, { busy: false })
		expect(usage(tracker, 4 * minute)).toEqual({ busyMs: minute, observedMs: 3 * minute })
		expect(usage(tracker, 4 * minute, { id: 2 })).toEqual({ busyMs: 0, observedMs: 0 })
	})
	it("excludes offline, disabled, absent, failed and long unobserved intervals", () => {
		const tracker = new AgentUtilization()
		usage(tracker, minute)
		usage(tracker, 2 * minute, { enabled: false })
		usage(tracker, 3 * minute)
		usage(tracker, 4 * minute, { status: "offline" })
		usage(tracker, 5 * minute)
		tracker.breakContinuity()
		usage(tracker, 6 * minute)
		usage(tracker, 10 * minute)
		tracker.observe([], 11 * minute, 2 * minute)
		expect(usage(tracker, 12 * minute)).toEqual({ busyMs: 0, observedMs: 0 })
		expect(usage(tracker, 13 * minute)).toEqual({ busyMs: minute, observedMs: minute })
	})
	it("restores history without counting the restart gap and clips a rolling 24-hour boundary", () => {
		const tracker = new AgentUtilization()
		usage(tracker, minute)
		usage(tracker, 2 * minute, { busy: false })
		usage(tracker, 3 * minute)
		const restored = new AgentUtilization(JSON.parse(JSON.stringify(tracker.snapshot())))
		expect(usage(restored, 10 * minute)).toEqual({ busyMs: minute, observedMs: 2 * minute })
		expect(usage(restored, 1441.5 * minute)).toEqual({ busyMs: minute / 2, observedMs: 1.5 * minute })
		usage(restored, 3000 * minute)
		expect(restored.snapshot()).toEqual({})
	})
	it("clears history when the pool changes and rejects corrupt persisted intervals", () => {
		const tracker = new AgentUtilization({
			1: [
				{ start: 1, end: 2, busy: true },
				{ start: 0, end: 3, busy: false },
				{ start: 4, end: 3, busy: true },
			],
		})
		expect(usage(tracker, minute)).toEqual({ busyMs: 1, observedMs: 1 })
		tracker.clear()
		expect(usage(tracker, 2 * minute)).toEqual({ busyMs: 0, observedMs: 0 })
	})
})
