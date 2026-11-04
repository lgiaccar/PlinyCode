import type { AgentUtilizationHistory, MonitoredAgent } from "@/shared/agent-monitor"

const WINDOW_MS = 24 * 60 * 60_000

/** Sampled busy time over observed online/enabled time in a rolling day. */
export class AgentUtilization {
	private history: AgentUtilizationHistory = {}
	private previous?: { at: number; agents: Map<number, MonitoredAgent> }

	constructor(saved: AgentUtilizationHistory = {}) {
		// Only well-formed intervals are accepted from local persisted state.
		for (const [id, intervals] of Object.entries(saved)) {
			if (!Array.isArray(intervals)) continue
			let end = 0
			this.history[id] = intervals
				.filter((item) => {
					if (
						!item ||
						!Number.isFinite(item.start) ||
						!Number.isFinite(item.end) ||
						item.start < end ||
						item.end <= item.start ||
						typeof item.busy !== "boolean"
					)
						return false
					end = item.end
					return true
				})
				.map((item) => ({ ...item }))
		}
	}

	breakContinuity(): void {
		this.previous = undefined
	}

	clear(): void {
		this.history = {}
		this.breakContinuity()
	}

	snapshot(): AgentUtilizationHistory {
		return this.history
	}

	observe(agents: MonitoredAgent[], now: number, maxGapMs: number): MonitoredAgent[] {
		const previous = this.previous
		this.previous = { at: now, agents: new Map(agents.map((agent) => [agent.id, agent])) }
		const cutoff = now - WINDOW_MS
		for (const [id, intervals] of Object.entries(this.history)) {
			this.history[id] = intervals
				.filter((item) => item.end > cutoff && item.end <= now)
				.map((item) => ({ ...item, start: Math.max(item.start, cutoff) }))
			if (!this.history[id].length) delete this.history[id]
		}
		return agents.map((agent) => {
			const before = previous?.agents.get(agent.id)
			const eligible = agent.status === "online" && agent.enabled && before?.status === "online" && before.enabled
			const intervals = this.history[agent.id] ?? []
			if (previous && eligible && now > previous.at && now - previous.at <= maxGapMs) {
				const last = intervals.at(-1)
				if (last?.end === previous.at && last.busy === before.busy) last.end = now
				else intervals.push({ start: Math.max(previous.at, cutoff), end: now, busy: before.busy })
				this.history[agent.id] = intervals.slice(-3000)
			}
			let busyMs = 0
			let observedMs = 0
			for (const interval of this.history[agent.id] ?? []) {
				const duration = interval.end - interval.start
				observedMs += duration
				if (interval.busy) busyMs += duration
			}
			return { ...agent, utilization: { busyMs, observedMs } }
		})
	}
}
