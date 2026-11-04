import {
	type AgentMonitorConfig,
	type AgentMonitorSnapshot,
	type AgentUtilizationHistory,
	DEFAULT_AGENT_MONITOR_CONFIG,
	type MonitoredAgent,
	matchesAgentCapability,
} from "@/shared/agent-monitor"
import { type AgentPoolSnapshot, agentQueueTarget } from "./agent-source"
import { AgentUtilization } from "./agent-utilization"

export interface AgentStatusChange {
	before: MonitoredAgent
	after: MonitoredAgent
}

export function describeAgentStatusChange({ before, after }: AgentStatusChange): string {
	const changes: string[] = []
	if (before.status !== "unknown" && after.status !== "unknown" && before.status !== after.status) {
		changes.push(`${before.status} → ${after.status}`)
	}
	if (before.enabled !== after.enabled) {
		changes.push(`${before.enabled ? "enabled" : "disabled"} → ${after.enabled ? "enabled" : "disabled"}`)
	}
	return `${after.name}: ${changes.join(", ")}`
}

export function validateAgentMonitorConfig(config: AgentMonitorConfig): AgentMonitorConfig {
	if (config.authentication !== "windows" && config.authentication !== "pat")
		throw new Error("Choose Windows sign-in or Personal access token.")
	if (!Array.isArray(config.capabilities) || config.capabilities.length > 30)
		throw new Error("Use at most 30 capability filters.")
	const capabilities = [...new Set(config.capabilities.map((value) => value.trim()).filter(Boolean))]
	if (capabilities.some((value) => value.length > 100 || !/^[^*\r\n]+\*?$|^\*$/.test(value))) {
		throw new Error("Use exact capability names or a prefix ending in *, such as FFI_BUILD_*.")
	}
	const queueUrl = config.queueUrl.trim() ? agentQueueTarget(config.queueUrl).queueUrl : ""
	if (config.enabled && !queueUrl) throw new Error("Enter an agent-pool URL before starting monitoring.")
	return {
		queueUrl,
		capabilities,
		authentication: config.authentication,
		enabled: Boolean(config.enabled),
		notify: Boolean(config.notify),
	}
}

/** Reuse only locally saved URLs. No internal endpoint belongs in the shipped defaults. */
export function initialAgentMonitorConfig(
	configs: Record<string, AgentMonitorConfig>,
	workspaceKey: string,
	defaultUrl: string,
	authentication: AgentMonitorConfig["authentication"],
): AgentMonitorConfig {
	try {
		if (configs[workspaceKey]) return validateAgentMonitorConfig(configs[workspaceKey])
	} catch {
		/* Fall back to a stopped monitor when saved settings are invalid. */
	}
	const defaults = { ...DEFAULT_AGENT_MONITOR_CONFIG, authentication }
	// Existing installs have workspace configurations but no explicit local default yet.
	const savedUrls = new Set(
		Object.values(configs)
			.map((config) => config?.queueUrl)
			.filter(Boolean),
	)
	const queueUrl = defaultUrl || (savedUrls.size === 1 ? [...savedUrls][0] : "")
	try {
		return validateAgentMonitorConfig({ ...defaults, queueUrl })
	} catch {
		return defaults
	}
}

/** One workspace's monitor. Snapshots stay in memory; only configuration is persisted by the host. */
export class AgentMonitor {
	private state: AgentMonitorSnapshot
	private timer?: ReturnType<typeof setTimeout>
	private pending?: Promise<void>
	private generation = 0
	private disposed = false
	private failures = 0
	private readonly utilization: AgentUtilization
	private readonly listeners = new Set<() => void>()

	constructor(
		private readonly deps: {
			read(config: AgentMonitorConfig): Promise<AgentPoolSnapshot>
			notify(changes: AgentStatusChange[]): void
			now?: () => number
			pollMs?: number
		},
		config: AgentMonitorConfig = DEFAULT_AGENT_MONITOR_CONFIG,
		history?: AgentUtilizationHistory,
	) {
		this.utilization = new AgentUtilization(history)
		this.state = {
			config: validateAgentMonitorConfig(config),
			agents: [],
			poolName: "",
			total: 0,
			updated: 0,
			refreshing: false,
			error: "",
		}
	}

	view(): AgentMonitorSnapshot {
		return this.state
	}
	utilizationHistory(): AgentUtilizationHistory {
		return this.utilization.snapshot()
	}
	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	private emit() {
		for (const listener of this.listeners) listener()
	}

	configure(config: AgentMonitorConfig): void {
		const valid = validateAgentMonitorConfig(config)
		if (valid.queueUrl !== this.state.config.queueUrl) this.utilization.clear()
		else this.utilization.breakContinuity()
		this.generation++
		clearTimeout(this.timer)
		this.failures = 0
		// Reset the baseline, including on filter changes: adding an offline agent isn't an outage.
		this.state = { config: valid, agents: [], poolName: "", total: 0, updated: 0, refreshing: false, error: "" }
		this.emit()
		const generation = this.generation
		if (this.pending)
			void this.pending.then(() => {
				if (generation === this.generation) void this.refresh()
			})
		else void this.refresh()
	}

	async refresh(): Promise<void> {
		if (this.disposed || !this.state.config.enabled) return
		if (this.pending) return this.pending
		clearTimeout(this.timer)
		const generation = this.generation
		const config = this.state.config
		this.state = { ...this.state, refreshing: true }
		this.emit()
		this.pending = this.poll(config, generation)
		try {
			await this.pending
		} finally {
			this.pending = undefined
			if (!this.disposed && generation === this.generation && this.state.config.enabled) {
				this.timer = setTimeout(
					() => void this.refresh(),
					Math.min(300_000, (this.deps.pollMs ?? 60_000) * 2 ** this.failures),
				)
				this.timer.unref?.()
			}
		}
	}

	private async poll(config: AgentMonitorConfig, generation: number): Promise<void> {
		try {
			const result = await this.deps.read(config)
			if (this.disposed || generation !== this.generation) return
			const now = (this.deps.now ?? Date.now)()
			const observed = this.utilization.observe(result.agents, now, (this.deps.pollMs ?? 60_000) * 2)
			const agents = observed
				.map((agent) => ({
					...agent,
					capabilities: config.capabilities.length
						? agent.capabilities.filter((name) => matchesAgentCapability(name, config.capabilities))
						: agent.capabilities,
				}))
				.filter((agent) => !config.capabilities.length || agent.capabilities.length)
				.sort((a, b) => a.name.localeCompare(b.name))
			const previous = new Map(this.state.agents.map((agent) => [agent.id, agent]))
			const changes: AgentStatusChange[] = agents.flatMap((agent) => {
				const before = previous.get(agent.id)
				if (!before) return []
				const connectionChanged =
					before.status !== "unknown" && agent.status !== "unknown" && before.status !== agent.status
				return connectionChanged || before.enabled !== agent.enabled ? [{ before, after: agent }] : []
			})
			this.failures = 0
			this.state = {
				config,
				agents,
				poolName: result.poolName,
				total: result.agents.length,
				updated: now,
				refreshing: false,
				error: "",
			}
			if (config.notify && changes.length) this.deps.notify(changes)
		} catch (error) {
			if (this.disposed || generation !== this.generation) return
			this.utilization.breakContinuity()
			this.failures = Math.min(3, this.failures + 1)
			this.state = {
				...this.state,
				refreshing: false,
				error: error instanceof Error ? error.message : "Unable to refresh agent status.",
			}
		}
		if (!this.disposed && generation === this.generation) this.emit()
	}

	dispose(): void {
		this.disposed = true
		this.generation++
		clearTimeout(this.timer)
		this.listeners.clear()
	}
}
