/**
 * MCP servers that ship with PlinyCode (currently the DevOps server). They are
 * not in the user's MCP settings file, so McpHub does not know them; the agent
 * picks up their tools from here instead. No `vscode` import, so the SDK
 * session code can depend on it.
 */
import type { McpToolProvider } from "@plinycode/core"

export interface BuiltinMcpSource {
	serverName: string
	timeoutMs: number
	provider: McpToolProvider
	isRunning(): boolean
	/** Current tool names, for building approval policies synchronously. */
	toolNames(): string[]
}

const sources = new Map<string, BuiltinMcpSource>()
const listeners = new Set<() => void>()

export function registerBuiltinMcpSource(source: BuiltinMcpSource): () => void {
	sources.set(source.serverName, source)
	notifyBuiltinMcpToolsChanged()
	return () => {
		if (sources.get(source.serverName) === source) {
			sources.delete(source.serverName)
			notifyBuiltinMcpToolsChanged()
		}
	}
}

export function getRunningBuiltinMcpSources(): BuiltinMcpSource[] {
	return [...sources.values()].filter((s) => s.isRunning())
}

export function notifyBuiltinMcpToolsChanged(): void {
	for (const listener of listeners) listener()
}

export function onBuiltinMcpToolsChanged(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export type DevOpsServerState = "off" | "starting" | "running" | "error"

export interface DevOpsServerStatus {
	state: DevOpsServerState
	error?: string
	tools: string[]
	/** Editor product name, e.g. "Visual Studio Code" or "Cursor". */
	editor: string
	/** How the editor's own AI chat reaches the server. */
	integration: "cursor" | "vscode" | "none"
	editorRegistered: boolean
	editorError?: string
	enabled: boolean
	registerWithEditor: boolean
}

/** What the webview handlers need from the DevOps server, without importing `vscode`. */
export interface DevOpsServerControl {
	readonly status: DevOpsServerStatus
	onDidChangeStatus(listener: (status: DevOpsServerStatus) => void): { dispose(): void }
	restart(): Promise<void>
	setEnabled(enabled: boolean): Promise<void>
	manualConfig(): Promise<string>
}

let devOpsControl: DevOpsServerControl | undefined

export function setDevOpsServerControl(control: DevOpsServerControl | undefined): void {
	devOpsControl = control
}

export function getDevOpsServerControl(): DevOpsServerControl | undefined {
	return devOpsControl
}
