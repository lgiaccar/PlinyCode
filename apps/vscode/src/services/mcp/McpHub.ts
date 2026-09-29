import type { McpPrompt, McpResource, McpResourceTemplate, McpServer, McpTool, McpToolCallResponse } from "@shared/mcp"
import type { FSWatcher } from "chokidar"
import { z } from "zod"
import { Logger } from "@/shared/services/Logger"
import {
	appendErrorMessage,
	fetchPromptsList,
	fetchResourcesList,
	fetchResourceTemplatesList,
	fetchServerCapabilities,
	fetchToolsList,
	refreshChangedList,
	scheduleListChangedRefresh,
} from "./capability-fetcher"
import { McpOAuthManager } from "./McpOAuthManager"
import {
	addRemoteServer,
	callTool,
	clearOAuthForConnection,
	deleteConnection,
	deleteServerRPC,
	getLatestMcpServersRPC,
	getSortedMcpServers,
	initiateOAuth,
	notifyWebviewOfServerChanges,
	reconcileMcpServersFromSettingsRPC,
	restartConnection,
	restartConnectionRPC,
	toggleServerDisabledRPC,
	toggleToolAutoApprove,
	toggleToolAutoApproveRPC,
	updateServerConnections,
	updateServerConnectionsRPC,
	updateServerTimeoutRPC,
} from "./mcp-rpc-facade"
import {
	computeConnectionFingerprint,
	getMcpSettingsFilePath,
	readAndValidateMcpSettingsFile,
	readPostWriteMcpSettings,
	recordSettingsFingerprint,
	stableJsonStringify,
	watchMcpSettingsFile,
} from "./mcp-settings-store"
import type { ServerConfigSchema } from "./schemas"
import { resolveMcpServerTimeoutMs } from "./timeout"
import { connectToServer as connectToServerImpl, removeAllFileWatchers, setupFileWatcher } from "./transport-factory"
import type { McpConnection, McpServerConfig } from "./types"

export class McpHub {
	getMcpServersPath: () => Promise<string>
	// Not `private`: the extracted mcp-*.ts modules take `this` as an explicit
	// host parameter, and TypeScript's structural typing rejects a `private`
	// member against the public shape those host interfaces declare. These
	// fields/methods are still internal implementation detail — only this
	// class and its sibling mcp-*.ts modules read them.
	getSettingsDirectoryPath: () => Promise<string>
	clientVersion: string
	mcpOAuthManager: McpOAuthManager

	settingsWatcher?: FSWatcher
	fileWatchers: Map<string, FSWatcher> = new Map()
	connections: McpConnection[] = []
	isConnecting = false
	/**
	 * Fingerprint of the connection-relevant view of the settings file as of the
	 * watcher's last reconciliation.
	 *
	 * The settings-file watcher uses this single, process-agnostic check to
	 * decide whether a file change needs action: it recomputes the fingerprint
	 * and skips when it's unchanged. Because the fingerprint is keyed on file
	 * CONTENT rather than on who wrote it:
	 *   - writes that change nothing connection-relevant (e.g. OAuth
	 *     codeVerifier/clientInformation churn during a handshake) are no-ops,
	 *     which prevents a self-perpetuating watcher → reconnect → write loop;
	 *   - a write from any other process (CLI, another window) that does change
	 *     something is processed normally;
	 *   - whether an access token is present is part of the fingerprint, so an
	 *     authorization completed elsewhere still triggers a reconnect via
	 *     serverGainedOAuthTokens.
	 *
	 * Combined with atomic writes, a reader can never
	 * observe a torn/empty file mid-write, so the worst case is a redundant
	 * reconciliation rather than dropping the server list.
	 */
	lastConnectionFingerprint?: string

	// Store notifications for display in chat
	pendingNotifications: Array<{
		serverName: string
		level: string
		message: string
		timestamp: number
	}> = []

	// Callback for sending notifications to active task
	notificationCallback?: (serverName: string, level: string, message: string) => void

	// Callback for notifying when the MCP tool list changes (servers added/removed/reconnected).
	// Used by SdkController to restart the SDK session with updated tools.
	private toolListChangeCallback?: () => void
	// Fingerprint of the last tool list snapshot, used to detect actual tool list changes
	// vs. mere status updates (e.g., error messages appended).
	private lastToolFingerprint = ""
	// Debounce timer for tool list change checks. When a server connects,
	// notifyWebviewOfServerChanges() fires multiple times in quick succession
	// (status change, tools discovered, etc.). Without debouncing, the callback
	// fires multiple times causing duplicate messages (S6-28).
	private toolListChangeDebounceTimer?: ReturnType<typeof setTimeout>
	// Debounce timers for list_changed notification refreshes, keyed by
	// "<serverName>:<kind>". Servers emit these notifications in bursts
	// (e.g. a toolset change or shutdown can produce a dozen
	// notifications/tools/list_changed at once), so refreshes are coalesced
	// per server and list kind.
	listChangedRefreshTimers: Map<string, ReturnType<typeof setTimeout>> = new Map()
	// In-flight list_changed refreshes, keyed like listChangedRefreshTimers.
	// A new refresh for the same key chains onto the in-flight one so
	// overlapping fetches can't complete out of order and publish stale lists.
	listChangedRefreshInFlight: Map<string, Promise<void>> = new Map()
	// Generation counter per key: every (re)schedule starts a new generation,
	// and a refresh whose generation is no longer current when it would
	// publish has been superseded by a newer notification — it drops its
	// result instead of briefly publishing an obsolete list.
	listChangedRefreshGeneration: Map<string, number> = new Map()
	// Deadline per key that caps how long re-debouncing can defer a refresh:
	// without it, a sustained stream of notifications arriving faster than
	// the debounce window would starve the refresh indefinitely.
	listChangedRefreshDeadlines: Map<string, number> = new Map()

	constructor(
		getMcpServersPath: () => Promise<string>,
		getSettingsDirectoryPath: () => Promise<string>,
		clientVersion: string,
	) {
		this.getMcpServersPath = getMcpServersPath
		this.getSettingsDirectoryPath = getSettingsDirectoryPath
		this.clientVersion = clientVersion
		this.mcpOAuthManager = new McpOAuthManager(() => this.getMcpSettingsFilePath())
		this.watchMcpSettingsFile()
		this.initializeMcpServers()
	}

	getServers(): McpServer[] {
		// Only return enabled servers

		return this.connections.filter((conn) => !conn.server.disabled).map((conn) => conn.server)
	}

	/**
	 * Gets the path to the MCP settings file
	 * @returns Path to the MCP settings file
	 */
	async getMcpSettingsFilePath(): Promise<string> {
		return getMcpSettingsFilePath(this)
	}

	/**
	 * Record the post-write connection fingerprint so this window's watcher treats
	 * its own write as a no-op. This does not write the settings file.
	 */
	recordSettingsFingerprint(servers: Record<string, McpServerConfig>): void {
		recordSettingsFingerprint(this, servers)
	}

	async readPostWriteMcpSettings() {
		return readPostWriteMcpSettings(this)
	}

	async readAndValidateMcpSettingsFile() {
		return readAndValidateMcpSettingsFile(this)
	}

	private async watchMcpSettingsFile(): Promise<void> {
		return watchMcpSettingsFile(this)
	}

	private async initializeMcpServers(): Promise<void> {
		const settings = await this.readAndValidateMcpSettingsFile()
		if (settings) {
			// Seed the watcher's baseline so the first post-startup write is
			// compared against the current connection-relevant state, not undefined.
			this.lastConnectionFingerprint = computeConnectionFingerprint(settings.mcpServers as Record<string, McpServerConfig>)
			await this.updateServerConnections(settings.mcpServers)
		}
	}

	findConnection(name: string, _source: "rpc" | "internal"): McpConnection | undefined {
		return this.connections.find((conn) => conn.server.name === name)
	}

	async connectToServer(name: string, config: z.infer<typeof ServerConfigSchema>, source: "rpc" | "internal"): Promise<void> {
		return connectToServerImpl(this, name, config, source)
	}

	appendErrorMessage(connection: McpConnection, error: string) {
		appendErrorMessage(connection, error)
	}

	/**
	 * Fetches the server's tools, resources, resource templates, and prompts
	 * onto the connection. See capability-fetcher.ts for details.
	 */
	async fetchServerCapabilities(connection: McpConnection): Promise<void> {
		return fetchServerCapabilities(this, connection)
	}

	async fetchToolsList(serverName: string): Promise<McpTool[] | undefined> {
		return fetchToolsList(this, serverName)
	}

	async fetchResourcesList(serverName: string): Promise<McpResource[] | undefined> {
		return fetchResourcesList(this, serverName)
	}

	async fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[] | undefined> {
		return fetchResourceTemplatesList(this, serverName)
	}

	async fetchPromptsList(serverName: string): Promise<McpPrompt[] | undefined> {
		return fetchPromptsList(this, serverName)
	}

	/**
	 * Debounced entry point for notifications/<kind>/list_changed. See
	 * capability-fetcher.ts for the debounce/retry design.
	 */
	scheduleListChangedRefresh(serverName: string, kind: "tools" | "resources" | "prompts", retryAttempt = 0): void {
		scheduleListChangedRefresh(this, serverName, kind, retryAttempt)
	}

	async refreshChangedList(
		serverName: string,
		kind: "tools" | "resources" | "prompts",
		superseded: () => boolean,
	): Promise<"refreshed" | "failed" | "skipped"> {
		return refreshChangedList(this, serverName, kind, superseded)
	}

	async deleteConnection(name: string): Promise<void> {
		return deleteConnection(this, name)
	}

	async clearOAuthForConnection(name: string): Promise<void> {
		return clearOAuthForConnection(this, name)
	}

	async updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void> {
		return updateServerConnectionsRPC(this, newServers)
	}

	async updateServerConnections(newServers: Record<string, McpServerConfig>): Promise<void> {
		return updateServerConnections(this, newServers)
	}

	/**
	 * Kept on the class only because a test reaches around TypeScript privacy
	 * to call it directly on a partially-constructed hub (see
	 * McpHub.deleteServerRPC.test.ts). Production code calls the standalone
	 * computeConnectionFingerprint in mcp-settings-store.ts directly; see
	 * configsRequireRestart/serverGainedOAuthTokens there for the sibling
	 * restart-decision helpers, which no longer need an McpHub wrapper.
	 */
	// biome-ignore lint/correctness/noUnusedPrivateClassMembers: exercised via (hub as any).computeConnectionFingerprint(...) in McpHub.deleteServerRPC.test.ts
	private computeConnectionFingerprint(mcpServers: Record<string, McpServerConfig>): string {
		return computeConnectionFingerprint(mcpServers)
	}

	setupFileWatcher(name: string, config: Extract<McpServerConfig, { type: "stdio" }>) {
		setupFileWatcher(this, name, config)
	}

	removeAllFileWatchers() {
		removeAllFileWatchers(this)
	}

	async restartConnectionRPC(serverName: string): Promise<McpServer[]> {
		return restartConnectionRPC(this, serverName)
	}

	async restartConnection(serverName: string): Promise<void> {
		return restartConnection(this, serverName)
	}

	/**
	 * Gets sorted MCP servers based on the order defined in settings
	 * @param serverOrder Array of server names in the order they appear in settings
	 * @returns Array of McpServer objects sorted according to settings order
	 */
	getSortedMcpServers(serverOrder: string[]): McpServer[] {
		return getSortedMcpServers(this.connections, serverOrder)
	}

	async notifyWebviewOfServerChanges(): Promise<void> {
		return notifyWebviewOfServerChanges(this)
	}

	async sendLatestMcpServers() {
		await this.notifyWebviewOfServerChanges()
	}

	async reconcileMcpServersFromSettingsRPC(): Promise<McpServer[]> {
		return reconcileMcpServersFromSettingsRPC(this)
	}

	async getLatestMcpServersRPC(): Promise<McpServer[]> {
		return getLatestMcpServersRPC(this)
	}

	// Using server

	// Public methods for server management

	public async toggleServerDisabledRPC(serverName: string, disabled: boolean): Promise<McpServer[]> {
		return toggleServerDisabledRPC(this, serverName, disabled)
	}

	async callTool(
		serverName: string,
		toolName: string,
		toolArguments: Record<string, unknown> | undefined,
		ulid: string,
		signal?: AbortSignal,
	): Promise<McpToolCallResponse> {
		return callTool(this, serverName, toolName, toolArguments, ulid, signal)
	}

	/**
	 * RPC variant of toggleToolAutoApprove that returns the updated servers instead of notifying the webview
	 * @param serverName The name of the MCP server
	 * @param toolNames Array of tool names to toggle auto-approve for
	 * @param shouldAllow Whether to enable or disable auto-approve
	 * @returns Array of updated MCP servers
	 */
	async toggleToolAutoApproveRPC(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<McpServer[]> {
		return toggleToolAutoApproveRPC(this, serverName, toolNames, shouldAllow)
	}

	async toggleToolAutoApprove(serverName: string, toolNames: string[], shouldAllow: boolean): Promise<void> {
		return toggleToolAutoApprove(this, serverName, toolNames, shouldAllow)
	}

	public async addRemoteServer(serverName: string, serverUrl: string, transportType = "streamableHttp"): Promise<McpServer[]> {
		return addRemoteServer(this, serverName, serverUrl, transportType)
	}

	/**
	 * RPC variant of deleteServer that returns the updated server list directly
	 * @param serverName The name of the server to delete
	 * @returns Array of remaining MCP servers
	 */
	public async deleteServerRPC(serverName: string): Promise<McpServer[]> {
		return deleteServerRPC(this, serverName)
	}

	public async updateServerTimeoutRPC(serverName: string, timeout: number): Promise<McpServer[]> {
		return updateServerTimeoutRPC(this, serverName, timeout)
	}

	/**
	 * Get and clear pending notifications
	 * @returns Array of pending notifications
	 */
	getPendingNotifications(): Array<{
		serverName: string
		level: string
		message: string
		timestamp: number
	}> {
		const notifications = [...this.pendingNotifications]
		this.pendingNotifications = []
		return notifications
	}

	/**
	 * Set the notification callback for real-time notifications
	 * @param callback Function to call when notifications arrive
	 */
	setNotificationCallback(callback: (serverName: string, level: string, message: string) => void): void {
		this.notificationCallback = callback
		//Logger.log("[MCP Debug] Notification callback set")
	}

	/**
	 * Clear the notification callback
	 */
	clearNotificationCallback(): void {
		this.notificationCallback = undefined
		//Logger.log("[MCP Debug] Notification callback cleared")
	}

	/**
	 * Set a callback that fires when the MCP tool list changes.
	 *
	 * The callback is invoked only when the set of available tools actually
	 * changes (servers added/removed, tools discovered/lost), NOT on mere
	 * status updates (error messages, reconnect attempts).
	 *
	 * Used by SdkController to restart the SDK session with updated tools
	 * when MCP servers change mid-session.
	 */
	setToolListChangeCallback(callback: () => void): void {
		this.toolListChangeCallback = callback
		// Initialize the fingerprint so the first real change is detected
		this.lastToolFingerprint = this.computeToolFingerprint()
	}

	/**
	 * Clear the tool list change callback.
	 */
	clearToolListChangeCallback(): void {
		this.toolListChangeCallback = undefined
	}

	/**
	 * Compute a fingerprint of the current tool list.
	 *
	 * The fingerprint is a sorted, deterministic representation of every value
	 * captured by createMcpTools: server name, tool name, description, input
	 * schema, and timeout. A change to any captured value must rebuild the active
	 * session even when the set of tool names is unchanged.
	 */
	computeToolFingerprint(): string {
		const entries: string[] = []
		for (const conn of this.connections) {
			if (conn.server.disabled || conn.server.status !== "connected") {
				continue
			}
			const timeoutMs = resolveMcpServerTimeoutMs(conn.server.config)
			for (const tool of conn.server.tools ?? []) {
				entries.push(
					stableJsonStringify([
						conn.server.name,
						tool.name,
						tool.description ?? null,
						tool.inputSchema ?? {},
						timeoutMs,
					]),
				)
			}
		}
		entries.sort()
		return JSON.stringify(entries)
	}

	/**
	 * Check if the tool list has changed and fire the callback if so.
	 * Called internally after server connection changes settle.
	 *
	 * Debounced: when a server connects, notifyWebviewOfServerChanges()
	 * fires multiple times in quick succession (status change → tools
	 * discovered → etc.). Without debouncing, the callback fires for
	 * each intermediate state, causing duplicate messages (S6-28).
	 * The 300ms debounce coalesces these into a single callback.
	 */
	checkToolListChanged(): void {
		if (!this.toolListChangeCallback) {
			return
		}

		// Quick-check: if the fingerprint hasn't changed, skip the debounce entirely.
		// This avoids scheduling timers for the many notifyWebviewOfServerChanges()
		// calls that don't actually change the tool list (e.g., error messages).
		const currentFingerprint = this.computeToolFingerprint()
		if (currentFingerprint === this.lastToolFingerprint) {
			return
		}

		// Fingerprint changed — debounce to coalesce rapid-fire changes
		if (this.toolListChangeDebounceTimer) {
			clearTimeout(this.toolListChangeDebounceTimer)
		}
		this.toolListChangeDebounceTimer = setTimeout(() => {
			this.toolListChangeDebounceTimer = undefined
			this.fireToolListChangeIfNeeded()
		}, 300)
	}

	/**
	 * Fire the tool list change callback if the fingerprint has changed.
	 * Called after the debounce timer expires.
	 */
	private fireToolListChangeIfNeeded(): void {
		if (!this.toolListChangeCallback) {
			return
		}
		const newFingerprint = this.computeToolFingerprint()
		if (newFingerprint !== this.lastToolFingerprint) {
			Logger.log(
				`[McpHub] Tool list changed: "${this.lastToolFingerprint.substring(0, 80)}" → "${newFingerprint.substring(0, 80)}"`,
			)
			this.lastToolFingerprint = newFingerprint
			try {
				this.toolListChangeCallback()
			} catch (error) {
				Logger.error("[McpHub] Error in toolListChangeCallback:", error)
			}
		}
	}

	/**
	 * Runs the complete OAuth flow for a server when the user clicks
	 * "Authenticate". See mcp-rpc-facade.ts for the full flow description.
	 */
	async initiateOAuth(serverName: string): Promise<void> {
		return initiateOAuth(this, serverName)
	}

	async dispose(): Promise<void> {
		for (const timer of this.listChangedRefreshTimers.values()) {
			clearTimeout(timer)
		}
		this.listChangedRefreshTimers.clear()
		this.listChangedRefreshGeneration.clear()
		this.listChangedRefreshDeadlines.clear()
		if (this.toolListChangeDebounceTimer) {
			clearTimeout(this.toolListChangeDebounceTimer)
			this.toolListChangeDebounceTimer = undefined
		}
		this.removeAllFileWatchers()
		for (const connection of this.connections) {
			try {
				await this.deleteConnection(connection.server.name)
			} catch (error) {
				Logger.error(`Failed to close connection for ${connection.server.name}:`, error)
			}
		}
		this.connections = []
		if (this.settingsWatcher) {
			await this.settingsWatcher.close()
		}
	}
}
