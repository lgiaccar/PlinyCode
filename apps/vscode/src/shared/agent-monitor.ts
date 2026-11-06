/** Saved per workspace. Credentials and agent capability values are never stored here. */
export interface AgentMonitorConfig {
	queueUrl: string
	capabilities: string[]
	authentication: "windows" | "pat"
	enabled: boolean
	notify: boolean
}

export const DEFAULT_AGENT_MONITOR_CONFIG: AgentMonitorConfig = {
	queueUrl: "",
	capabilities: ["BUILD_*", "PERFORMANCE", "FFI_BUILD_*"],
	authentication: "windows",
	enabled: false,
	notify: true,
}

export interface MonitoredAgent {
	hostname?: string
	id: number
	name: string
	status: "online" | "offline" | "unknown"
	enabled: boolean
	busy: boolean
	capabilities: string[]
	url: string
	jobName: string
	jobUrl: string
	pipelineName?: string
	runName?: string
	os?: "windows" | "linux" | "macos" | "unknown"
	utilization?: { busyMs: number; observedMs: number }
}

/** Eligible observed intervals only; no credentials, names or capability values. */
export type AgentUtilizationHistory = Record<string, { start: number; end: number; busy: boolean }[]>

export interface SavedAgentPool {
	id: string
	config: AgentMonitorConfig
	utilizationHistory?: AgentUtilizationHistory
}

export interface AgentMonitorSnapshot {
	config: AgentMonitorConfig
	poolName: string
	agents: MonitoredAgent[]
	total: number
	updated: number
	refreshing: boolean
	error: string
}

/** A literal capability name, or a prefix ending in *. Multiple filters mean ANY, not ALL. */
export function matchesAgentCapability(name: string, filters: string[]): boolean {
	return filters.some((filter) => (filter.endsWith("*") ? name.startsWith(filter.slice(0, -1)) : name === filter))
}
