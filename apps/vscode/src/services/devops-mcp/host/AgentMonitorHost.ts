import * as vscode from "vscode"
import { StateManager } from "@/core/storage/StateManager"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import type { AgentMonitorConfig } from "@/shared/agent-monitor"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import {
	AgentMonitor,
	describeAgentStatusChange,
	initialAgentMonitorConfig,
	validateAgentMonitorConfig,
} from "../agents/agent-monitor"
import { readAgentPool } from "../agents/agent-source"
import type { EditorTokenSource } from "../server/auth"

export class AgentMonitorHost implements vscode.Disposable {
	static current?: AgentMonitorHost
	monitor?: AgentMonitor
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
		const config = initialAgentMonitorConfig(
			state.getGlobalStateKey("agentMonitorConfigs"),
			this.workspaceKey,
			state.getGlobalStateKey("agentMonitorDefaultQueueUrl"),
			process.platform === "win32" ? "windows" : "pat",
		)
		this.monitor = new AgentMonitor(
			{
				read: (settings) => {
					if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting to an agent pool.")
					return readAgentPool(settings, this.token)
				},
				notify: (agents) => {
					const text = agents.map(describeAgentStatusChange).join("; ")
					void HostProvider.window
						.showMessage({ type: ShowMessageType.INFORMATION, message: `PlinyCode agents — ${text}` })
						.catch((error) => Logger.error("[Agents] Notification failed:", error))
				},
			},
			config,
		)
		void this.monitor.refresh()
	}

	configure(config: AgentMonitorConfig): void {
		if (!this.monitor) throw new Error("Agent monitor is still starting. Reopen Pipelines in a moment.")
		if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting to an agent pool.")
		const valid = validateAgentMonitorConfig(config)
		const state = StateManager.get()
		state.setGlobalState("agentMonitorConfigs", {
			...state.getGlobalStateKey("agentMonitorConfigs"),
			[this.workspaceKey]: valid,
		})
		if (valid.enabled) state.setGlobalState("agentMonitorDefaultQueueUrl", valid.queueUrl)
		this.monitor.configure(valid)
	}

	dispose() {
		this.disposed = true
		this.monitor?.dispose()
		if (AgentMonitorHost.current === this) AgentMonitorHost.current = undefined
	}
}
