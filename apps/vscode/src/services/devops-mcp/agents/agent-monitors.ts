import { randomUUID } from "node:crypto"
import type { AgentMonitorConfig, SavedAgentPool } from "@/shared/agent-monitor"
import { AgentMonitor, type AgentStatusChange, initialAgentMonitorConfig, validateAgentMonitorConfig } from "./agent-monitor"
import type { AgentPoolSnapshot } from "./agent-source"

/** An empty saved list is intentional and must not resurrect the old single monitor. */
export function initialAgentPools(
	pools: Record<string, SavedAgentPool[]>,
	legacy: Record<string, AgentMonitorConfig>,
	workspace: string,
	defaultUrl: string,
	authentication: AgentMonitorConfig["authentication"],
): SavedAgentPool[] {
	return (
		pools[workspace] ?? [{ id: "default", config: initialAgentMonitorConfig(legacy, workspace, defaultUrl, authentication) }]
	)
}

/** Independent pollers: a slow or failing pool never blocks another pool's updates. */
export class AgentMonitors {
	private readonly monitors = new Map<string, AgentMonitor>()
	private readonly listeners = new Set<() => void>()

	constructor(
		private readonly deps: {
			read(config: AgentMonitorConfig): Promise<AgentPoolSnapshot>
			notify(pool: string, changes: AgentStatusChange[]): void
		},
		pools: SavedAgentPool[],
	) {
		for (const pool of pools) this.add(pool.id, pool.config)
	}

	private add(id: string, config: AgentMonitorConfig) {
		const monitor = new AgentMonitor(
			{
				read: this.deps.read,
				notify: (changes) => this.deps.notify(monitor.view().poolName || monitor.view().config.queueUrl, changes),
			},
			config,
		)
		this.monitors.set(id, monitor)
		monitor.onDidChange(() => this.emit())
	}

	view() {
		return { pools: [...this.monitors].map(([id, monitor]) => ({ ...monitor.view(), id })) }
	}

	configs(): SavedAgentPool[] {
		return [...this.monitors].map(([id, monitor]) => ({ id, config: monitor.view().config }))
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	private emit() {
		for (const listener of this.listeners) listener()
	}

	configure(id: string, config: AgentMonitorConfig): string {
		const valid = validateAgentMonitorConfig(config)
		const existing = this.monitors.get(id)
		if (id && !existing) throw new Error("This pool was removed. Add it again to monitor it.")
		if (valid.queueUrl && this.configs().some((pool) => pool.id !== id && pool.config.queueUrl === valid.queueUrl))
			throw new Error("This agent-pool URL is already saved. Select its existing monitor.")
		if (existing) existing.configure(valid)
		else {
			id = randomUUID()
			this.add(id, valid)
			this.emit()
			void this.refresh(id)
		}
		return id
	}

	remove(id: string): void {
		const monitor = this.monitors.get(id)
		if (!monitor) throw new Error("This pool was already removed.")
		monitor.dispose()
		this.monitors.delete(id)
		this.emit()
	}

	async refresh(id?: string): Promise<void> {
		if (id) {
			const monitor = this.monitors.get(id)
			if (!monitor) throw new Error("This pool was removed.")
			await monitor.refresh()
		} else await Promise.all([...this.monitors.values()].map((monitor) => monitor.refresh()))
	}

	dispose(): void {
		for (const monitor of this.monitors.values()) monitor.dispose()
		this.listeners.clear()
	}
}
