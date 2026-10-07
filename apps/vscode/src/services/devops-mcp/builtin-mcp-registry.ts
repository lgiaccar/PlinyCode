/**
 * MCP servers that ship with PlinyCode (currently the DevOps server). They are
 * not in the user's MCP settings file, so McpHub does not know them; the agent
 * picks up their tools from here instead. No `vscode` import, so the SDK
 * session code can depend on it.
 */
import type { McpToolProvider } from "@plinycode/core"
import type { AgentTool } from "@plinycode/shared"
import type { CiBoard } from "./ci-board/ci-board"
import type { CiWatchManager } from "./ci-watch/ci-watch-manager"

interface BuiltinMcpSource {
	serverName: string
	timeoutMs: number
	provider: McpToolProvider
	isRunning(): boolean
	/** Current tool names, for building approval policies synchronously. */
	toolNames(): string[]
	/**
	 * Whether the server is any use in a session rooted at `cwd`. Tool schemas
	 * are sent with every request, so a server that cannot act in this
	 * workspace should stay out of it. Omitted means always.
	 */
	appliesTo?(cwd: string): Promise<boolean>
	/**
	 * Tools that run in the extension rather than in the server process, offered
	 * to a session rooted at `cwd` together with the server's own (e.g. `watch_ci`,
	 * which has to reach the conversation later).
	 */
	extraTools?(cwd: string): AgentTool[]
	/**
	 * The tool provider for a session rooted at `cwd`, when calls need to know
	 * it (the DevOps tools default to the window's folder, which is the wrong
	 * repository for a session running in a git worktree). Omitted: `provider`.
	 */
	providerFor?(cwd: string): McpToolProvider
}

/** `provider`, with `name: value` filled into every call that does not set `name` itself. */
export function withDefaultArgument(provider: McpToolProvider, name: string, value: string): McpToolProvider {
	return {
		listTools: (serverName) => provider.listTools(serverName),
		callTool: (request) =>
			provider.callTool(
				request.arguments?.[name] ? request : { ...request, arguments: { ...request.arguments, [name]: value } },
			),
	}
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

let ciWatchManager: CiWatchManager | undefined

/** The controller owns the CI watches (it delivers their reports); the DevOps service builds `watch_ci` on them. */
export function setCiWatchManager(manager: CiWatchManager | undefined): void {
	ciWatchManager = manager
}

export function getCiWatchManager(): CiWatchManager | undefined {
	return ciWatchManager
}

let ciBoard: CiBoard | undefined

/** The window's CI board; the DevOps service builds it, the webview handlers read it. */
export function setCiBoard(board: CiBoard | undefined): void {
	ciBoard = board
}

export function getCiBoard(): CiBoard | undefined {
	return ciBoard
}
