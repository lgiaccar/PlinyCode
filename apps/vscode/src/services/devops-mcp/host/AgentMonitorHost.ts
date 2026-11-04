import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import type { AgentMonitorConfig } from "@/shared/agent-monitor"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { describeAgentStatusChange, validateAgentMonitorConfig } from "../agents/agent-monitor"
import { AgentMonitors, initialAgentPools } from "../agents/agent-monitors"
import { readAgentPool } from "../agents/agent-source"
import type { EditorTokenSource } from "../server/auth"

export class AgentMonitorHost implements vscode.Disposable {
	static current?: AgentMonitorHost
	monitor?: AgentMonitors
	private workspaceKey = ""
	private disposed = false
	private constructor(private readonly token: EditorTokenSource) {}

	static start(token: EditorTokenSource): AgentMonitorHost {
		const host = new AgentMonitorHost(token)
		AgentMonitorHost.current = host
		host.init().catch((error) => Logger.error("[Agents] Failed to start:", error))
		return host
	}

	private async init() {
		this.workspaceKey = workspaceRefFromWindow(await HostProvider.workspace.getWorkspacePaths({}))?.path ?? ""
		if (this.disposed) return
		const state = StateManager.get()
		const pools = initialAgentPools(
			state.getGlobalStateKey("agentMonitorPools"),
			state.getGlobalStateKey("agentMonitorConfigs"),
			this.workspaceKey,
			state.getGlobalStateKey("agentMonitorDefaultQueueUrl"),
			process.platform === "win32" ? "windows" : "pat",
		)
		this.monitor = new AgentMonitors(
			{
				read: (settings) => {
					if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting to an agent pool.")
					return readAgentPool(settings, this.token)
				},
				notify: (pool, agents) => {
					const text = agents.map(describeAgentStatusChange).join("; ")
					void HostProvider.window
						.showMessage({ type: ShowMessageType.INFORMATION, message: `PlinyCode agents (${pool}) - ${text}` })
						.catch((error) => Logger.error("[Agents] Notification failed:", error))
				},
			},
			pools,
		)
		this.monitor.onDidChange(() => this.persistHistory())
		this.persist()
		void this.monitor.refresh()
	}

	configure(id: string, config: AgentMonitorConfig): string {
		if (!this.monitor) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
		if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting to an agent pool.")
		const valid = validateAgentMonitorConfig(config)
		const state = StateManager.get()
		const poolId = this.monitor.configure(id, valid)
		this.persist()
		if (valid.enabled) state.setGlobalState("agentMonitorDefaultQueueUrl", valid.queueUrl)
		return poolId
	}

	remove(id: string): void {
		if (!this.monitor) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
		this.monitor.remove(id)
		this.persist()
	}

	private persist(): void {
		if (!this.monitor) return
		const state = StateManager.get()
		state.setGlobalState("agentMonitorPools", {
			...state.reloadGlobalStateKey("agentMonitorPools"),
			[this.workspaceKey]: this.monitor.configs(),
		})
	}

	private persistHistory(): void {
		if (!this.monitor) return
		const state = StateManager.get()
		const saved = state.reloadGlobalStateKey("agentMonitorPools")
		const current = new Map(this.monitor.configs().map((pool) => [pool.id, pool]))
		// Polling must not resurrect pools or overwrite settings changed in another window.
		const pools = saved[this.workspaceKey]
		if (!pools) return
		state.setGlobalState("agentMonitorPools", {
			...saved,
			[this.workspaceKey]: pools.map((pool) => {
				const latest = current.get(pool.id)
				return latest?.config.queueUrl === pool.config.queueUrl
					? { ...pool, utilizationHistory: latest.utilizationHistory }
					: pool
			}),
		})
	}

	dispose() {
		this.disposed = true
		this.monitor?.dispose()
		if (AgentMonitorHost.current === this) AgentMonitorHost.current = undefined
	}
}
