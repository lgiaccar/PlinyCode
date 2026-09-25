import fs from "node:fs/promises"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { McpToolProvider } from "@plinycode/core"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"
import {
	type DevOpsServerControl,
	type DevOpsServerState,
	type DevOpsServerStatus,
	notifyBuiltinMcpToolsChanged,
	registerBuiltinMcpSource,
	setDevOpsServerControl,
} from "../builtin-mcp-registry"
import {
	detectEditorIntegration,
	EDITOR_SERVER_NAME,
	type EditorIntegration,
	type LaunchSpec,
	registerWithEditor,
} from "./editor-registration"
import { TokenBroker } from "./token-broker"

/** Name the agent sees: tools are exposed as `plinycode-devops__<tool>`. */
export const DEVOPS_SERVER_NAME = EDITOR_SERVER_NAME
const SETTING_ENABLED = "plinycode.devops.enabled"
const SETTING_EDITOR = "plinycode.devops.registerWithEditor"
const TOOL_TIMEOUT_MS = 120_000
const MAX_AUTO_RESTARTS = 3

interface ToolInfo {
	name: string
	description?: string
	inputSchema: Record<string, unknown>
}

/**
 * Runs the built-in DevOps MCP server (PRs and pipelines for GitHub / Azure
 * DevOps) for PlinyCode's agent, and offers the same server to the editor's own
 * AI chat. It lives beside McpHub, which only manages servers from the user's
 * MCP settings file, so the user's file is never touched.
 */
export class DevOpsMcpService implements vscode.Disposable, DevOpsServerControl {
	private static current?: DevOpsMcpService

	static get instance(): DevOpsMcpService | undefined {
		return DevOpsMcpService.current
	}

	private client?: Client
	private tools: ToolInfo[] = []
	private state: DevOpsServerState = "off"
	private error?: string
	private integration: EditorIntegration = "none"
	private editorRegistration?: vscode.Disposable
	private editorError?: string
	private autoRestarts = 0
	private stopping = false
	private generation = 0
	private readonly statusListeners = new Set<(status: DevOpsServerStatus) => void>()
	private readonly disposables: vscode.Disposable[] = []

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly broker: TokenBroker,
	) {}

	static async activate(context: vscode.ExtensionContext): Promise<DevOpsMcpService> {
		const service = new DevOpsMcpService(context, await TokenBroker.start())
		DevOpsMcpService.current = service
		setDevOpsServerControl(service)
		context.subscriptions.push(service)
		service.integration = detectEditorIntegration()
		const unregister = registerBuiltinMcpSource({
			serverName: DEVOPS_SERVER_NAME,
			timeoutMs: TOOL_TIMEOUT_MS,
			provider: service.toolProvider,
			isRunning: () => service.state === "running",
			toolNames: () => service.tools.map((t) => t.name),
		})
		service.disposables.push(
			new vscode.Disposable(unregister),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration(SETTING_ENABLED) || event.affectsConfiguration(SETTING_EDITOR)) {
					void service.applySettings()
				}
			}),
		)
		await service.applySettings()
		return service
	}

	get scriptPath(): string {
		return path.join(this.context.extensionPath, "dist", "devops-mcp.js")
	}

	private get version(): string {
		return String(this.context.extension.packageJSON.version ?? "")
	}

	private get enabled(): boolean {
		return vscode.workspace.getConfiguration().get<boolean>(SETTING_ENABLED, true)
	}

	private get shareWithEditor(): boolean {
		return vscode.workspace.getConfiguration().get<boolean>(SETTING_EDITOR, true)
	}

	private workspaceFolder(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
	}

	/** How to start the server: the editor's own runtime in Node mode, so users need no Node or Python. */
	launchSpec(scriptPath = this.scriptPath, withBroker = true): LaunchSpec {
		const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1" }
		const folder = this.workspaceFolder()
		if (folder) env.DEVOPS_MCP_WORKSPACE = folder
		return { command: process.execPath, args: [scriptPath], env: withBroker ? { ...env, ...this.broker.env } : env }
	}

	get status(): DevOpsServerStatus {
		return {
			state: this.state,
			error: this.error,
			tools: this.tools.map((t) => t.name),
			editor: vscode.env.appName,
			integration: this.integration,
			editorRegistered: this.editorRegistration !== undefined,
			editorError: this.editorError,
			enabled: this.enabled,
			registerWithEditor: this.shareWithEditor,
		}
	}

	onDidChangeStatus(listener: (status: DevOpsServerStatus) => void): vscode.Disposable {
		this.statusListeners.add(listener)
		return new vscode.Disposable(() => this.statusListeners.delete(listener))
	}

	private setState(state: DevOpsServerState, error?: string): void {
		const toolsBefore = this.tools.map((t) => t.name).join(",")
		if (state !== "running") {
			this.tools = state === "starting" ? this.tools : []
		}
		this.state = state
		this.error = error
		this.emit(toolsBefore !== this.tools.map((t) => t.name).join(","))
	}

	private emit(toolsChanged = false): void {
		const status = this.status
		for (const listener of this.statusListeners) listener(status)
		if (toolsChanged) {
			// Lets an active PlinyCode session reload its tools.
			notifyBuiltinMcpToolsChanged()
		}
	}

	async setEnabled(enabled: boolean): Promise<void> {
		await vscode.workspace.getConfiguration().update(SETTING_ENABLED, enabled, vscode.ConfigurationTarget.Global)
		await this.applySettings()
	}

	private async applySettings(): Promise<void> {
		if (this.enabled) {
			if (this.state === "off") {
				this.autoRestarts = 0
				await this.start()
			}
		} else {
			await this.stop()
		}
		this.updateEditorRegistration()
	}

	private updateEditorRegistration(): void {
		const want = this.enabled && this.shareWithEditor && this.integration !== "none"
		if (want && !this.editorRegistration) {
			try {
				this.editorRegistration = registerWithEditor(this.integration, this.launchSpec(), this.version)
				this.editorError = undefined
				Logger.log(`[DevOpsMcp] Registered with the editor (${this.integration})`)
			} catch (error) {
				this.editorError = error instanceof Error ? error.message : String(error)
				Logger.warn(`[DevOpsMcp] Could not register with the editor: ${this.editorError}`)
			}
		} else if (!want && this.editorRegistration) {
			this.editorRegistration.dispose()
			this.editorRegistration = undefined
		}
		this.emit()
	}

	async restart(): Promise<void> {
		this.autoRestarts = 0
		await this.stop()
		if (this.enabled) {
			await this.start()
		}
	}

	private async start(): Promise<void> {
		const generation = ++this.generation
		this.setState("starting")
		const spec = this.launchSpec()
		const transport = new StdioClientTransport({
			command: spec.command,
			args: spec.args,
			cwd: this.workspaceFolder(),
			// The user's environment carries PATH (git, gh, az), proxies and any GITHUB_TOKEN / AZURE_DEVOPS_PAT.
			env: { ...definedEnv(process.env), ...spec.env },
			stderr: "pipe",
		})
		transport.stderr?.on("data", (chunk: Buffer) => Logger.log(`[DevOpsMcp] ${chunk.toString("utf8").trimEnd()}`))
		const client = new Client({ name: "plinycode", version: this.version })
		client.onclose = () => this.handleExit(generation)
		try {
			await client.connect(transport)
			const { tools } = await client.listTools()
			if (generation !== this.generation) {
				await client.close()
				return
			}
			this.client = client
			this.tools = tools.map((t) => ({
				name: t.name,
				description: t.description,
				inputSchema: t.inputSchema as Record<string, unknown>,
			}))
			this.setState("running")
			Logger.log(`[DevOpsMcp] Running with ${tools.length} tools`)
		} catch (error) {
			await client.close().catch(() => {})
			if (generation === this.generation) {
				this.setState("error", `Could not start the server: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	private handleExit(generation: number): void {
		if (this.stopping || generation !== this.generation || this.state !== "running") {
			return
		}
		this.client = undefined
		if (this.autoRestarts < MAX_AUTO_RESTARTS) {
			this.autoRestarts++
			Logger.warn(`[DevOpsMcp] Server exited; restarting (attempt ${this.autoRestarts})`)
			setTimeout(() => void this.start(), 1000 * this.autoRestarts)
			this.setState("starting")
		} else {
			this.setState("error", "The server stopped unexpectedly. Use Restart to try again, and see Output → PlinyCode.")
		}
	}

	private async stop(): Promise<void> {
		this.generation++
		const client = this.client
		this.client = undefined
		if (client) {
			this.stopping = true
			await client.close().catch(() => {})
			this.stopping = false
		}
		this.setState("off")
	}

	/** Tool provider for `createMcpTools`; empty while the server is not running. */
	readonly toolProvider: McpToolProvider = {
		listTools: async () => (this.state === "running" ? this.tools : []),
		callTool: async (request) => {
			if (!this.client || this.state !== "running") {
				throw new Error("The PlinyCode DevOps server is not running. Check the MCP Servers view.")
			}
			const result = await this.client.callTool({ name: request.toolName, arguments: request.arguments ?? {} }, undefined, {
				timeout: TOOL_TIMEOUT_MS,
				signal: request.context?.signal,
			})
			return { ...result, content: result.content ?? [] }
		},
	}

	/**
	 * MCP config for clients the extension cannot register with directly. The
	 * server script is copied to the extension's global storage so the path
	 * survives extension updates. Such clients sign in with GITHUB_TOKEN /
	 * AZURE_DEVOPS_PAT or a `gh` / `az` login (the editor broker is per window).
	 */
	async manualConfig(): Promise<string> {
		const dir = this.context.globalStorageUri.fsPath
		await fs.mkdir(dir, { recursive: true })
		const stable = path.join(dir, "devops-mcp.js")
		await fs.copyFile(this.scriptPath, stable)
		const spec = this.launchSpec(stable, false)
		delete spec.env.DEVOPS_MCP_WORKSPACE
		return JSON.stringify({ mcpServers: { [EDITOR_SERVER_NAME]: spec } }, null, 2)
	}

	dispose(): void {
		void this.stop()
		this.editorRegistration?.dispose()
		this.editorRegistration = undefined
		this.broker.dispose()
		for (const d of this.disposables) d.dispose()
		this.statusListeners.clear()
		if (DevOpsMcpService.current === this) {
			DevOpsMcpService.current = undefined
			setDevOpsServerControl(undefined)
		}
	}
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(env)) {
		if (value !== undefined) out[key] = value
	}
	return out
}
