import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { sendMcpServersUpdate } from "@core/controller/mcp/subscribeToMcpServers"
import { getMcpSettingsFilePath as getMcpSettingsFilePathHelper } from "@core/storage/disk"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { MAX_MCP_TIMEOUT_SECONDS, type McpServer, type McpToolCallResponse, MIN_MCP_TIMEOUT_SECONDS } from "@shared/mcp"
import { convertMcpServersToProtoMcpServers } from "@shared/proto-conversions/mcp/mcp-server-conversion"
import type { FSWatcher } from "chokidar"
import * as fs from "fs/promises"
import { z } from "zod"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { expandEnvironmentVariables } from "@/utils/envExpansion"
import type { McpOAuthManager } from "./McpOAuthManager"
import {
	configsRequireRestart,
	readAndValidateMcpSettingsFile,
	readPostWriteMcpSettings,
	serverGainedOAuthTokens,
} from "./mcp-settings-store"
import { McpTimeoutSecondsSchema, ServerConfigSchema } from "./schemas"
import { updateMcpSettingsFile } from "./settingsLock"
import { augmentMcpTimeoutError, resolveMcpServerTimeoutMs } from "./timeout"
import { setupFileWatcher } from "./transport-factory"
import type { McpConnection, McpServerConfig } from "./types"

/**
 * The subset of McpHub's state and behavior needed by the RPC-facing surface
 * the webview/controller call, server lifecycle management (add/remove/
 * restart/reconcile), and OAuth/notification bookkeeping. Passed explicitly
 * rather than owned here, so the fields keep living directly on the McpHub
 * instance (tests build partial McpHub instances and poke these fields/
 * methods directly).
 */
export interface McpRpcFacadeHost {
	connections: McpConnection[]
	isConnecting: boolean
	mcpOAuthManager: McpOAuthManager
	fileWatchers: Map<string, FSWatcher>
	getSettingsDirectoryPath: () => Promise<string>
	connectToServer(name: string, config: z.infer<typeof ServerConfigSchema>, source: "rpc" | "internal"): Promise<void>
	deleteConnection(name: string): Promise<void>
	removeAllFileWatchers(): void
	restartConnection(serverName: string): Promise<void>
	checkToolListChanged(): void
	appendErrorMessage(connection: McpConnection, error: string): void
}

export async function deleteConnection(host: McpRpcFacadeHost, name: string): Promise<void> {
	const connection = host.connections.find((conn) => conn.server.name === name)
	if (connection) {
		// Remove from published state BEFORE awaiting the close handshake:
		// concurrent publishers (list refreshes finishing their fetch,
		// notifyWebviewOfServerChanges callers) read this.connections after
		// their own suspension points, and must not see — or re-publish —
		// a connection that is being torn down.
		host.connections = host.connections.filter((conn) => conn.server.name !== name)
		try {
			// Only close transport and client if they exist (disabled servers don't have them)
			if (connection.transport) {
				await connection.transport.close()
			}
			if (connection.client) {
				await connection.client.close()
			}
		} catch (error) {
			Logger.error(`Failed to close transport for ${name}:`, error)
		}
	}
}

export async function clearOAuthForConnection(host: McpRpcFacadeHost, name: string): Promise<void> {
	const connection = host.connections.find((conn) => conn.server.name === name)
	if (connection) {
		try {
			const config = JSON.parse(connection.server.config)
			if (config.url) {
				await host.mcpOAuthManager.clearServerAuth(name, config.url)
			}
		} catch (error) {
			Logger.error(`Failed to clear OAuth data for ${name}:`, error)
		}
	}
}

export async function updateServerConnectionsRPC(
	host: McpRpcFacadeHost,
	newServers: Record<string, McpServerConfig>,
): Promise<void> {
	host.isConnecting = true
	host.removeAllFileWatchers()
	const currentNames = new Set(host.connections.map((conn) => conn.server.name))
	const newNames = new Set(Object.keys(newServers))

	// Delete removed servers
	for (const name of currentNames) {
		if (!newNames.has(name)) {
			await host.deleteConnection(name)
			Logger.log(`Deleted MCP server: ${name}`)
		}
	}

	// Update or add servers
	for (const [name, config] of Object.entries(newServers)) {
		const currentConnection = host.connections.find((conn) => conn.server.name === name)

		if (!currentConnection) {
			// New server
			try {
				if (config.type === "stdio") {
					setupFileWatcher(host, name, config)
				}
				await host.connectToServer(name, config, "rpc")
			} catch (error) {
				Logger.error(`Failed to connect to new MCP server ${name}:`, error)
			}
		} else if (
			configsRequireRestart(JSON.parse(currentConnection.server.config), config) ||
			serverGainedOAuthTokens(currentConnection, config)
		) {
			// Existing server with changed connection config,
			// or an unauthenticated server whose OAuth tokens just appeared (e.g. CLI authorized it)
			try {
				if (config.type === "stdio") {
					setupFileWatcher(host, name, config)
				}
				await host.deleteConnection(name) // Don't clear OAuth - just reconnecting with new config
				await host.connectToServer(name, config, "rpc")
				Logger.log(`Reconnected MCP server with updated config: ${name}`)
			} catch (error) {
				Logger.error(`Failed to reconnect MCP server ${name}:`, error)
			}
		} else {
			// Only PlinyCode-specific settings changed - update in-memory state without restart
			const autoApprove = config.autoApprove || []
			if (currentConnection.server.tools) {
				currentConnection.server.tools = currentConnection.server.tools.map((tool) => ({
					...tool,
					autoApprove: autoApprove.includes(tool.name),
				}))
			}
			// Also update PlinyCode-specific settings in the stored config.
			// This handles the case where someone manually edits the MCP settings file -
			// the file watcher triggers this code path, and we need to sync the in-memory
			// config with the file without restarting the server.
			const currentConfig = JSON.parse(currentConnection.server.config)
			currentConfig.autoApprove = config.autoApprove
			currentConfig.timeout = config.timeout
			currentConnection.server.config = JSON.stringify(currentConfig)
		}
	}

	// MCP agent tools snapshot server metadata and timeout when a session is
	// built. Reconciliation must enroll that snapshot boundary even when the
	// set of tool names is unchanged.
	host.checkToolListChanged()
	host.isConnecting = false
}

export interface McpConnectionUpdateHost extends McpRpcFacadeHost {
	clearOAuthForConnection(name: string): Promise<void>
	notifyWebviewOfServerChanges(): Promise<void>
}

export async function updateServerConnections(
	host: McpConnectionUpdateHost,
	newServers: Record<string, McpServerConfig>,
): Promise<void> {
	host.isConnecting = true
	host.removeAllFileWatchers()
	const currentNames = new Set(host.connections.map((conn) => conn.server.name))
	const newNames = new Set(Object.keys(newServers))

	// Track if any connection-level changes occurred (excludes PlinyCode-specific settings)
	let connectionChangesOccurred = false

	// Delete removed servers
	for (const name of currentNames) {
		if (!newNames.has(name)) {
			await host.clearOAuthForConnection(name) // Clear OAuth data first
			await host.deleteConnection(name) // Then delete connection
			Logger.log(`Deleted MCP server: ${name}`)
			connectionChangesOccurred = true
		}
	}

	// Update or add servers
	for (const [name, config] of Object.entries(newServers)) {
		const currentConnection = host.connections.find((conn) => conn.server.name === name)

		if (!currentConnection) {
			// New server
			try {
				if (config.type === "stdio") {
					setupFileWatcher(host, name, config)
				}
				await host.connectToServer(name, config, "internal")
				connectionChangesOccurred = true
			} catch (error) {
				Logger.error(`Failed to connect to new MCP server ${name}:`, error)
				// connectToServer registered a disconnected entry carrying
				// the error; the webview must be told about it.
				connectionChangesOccurred = true
			}
		} else if (
			configsRequireRestart(JSON.parse(currentConnection.server.config), config) ||
			serverGainedOAuthTokens(currentConnection, config)
		) {
			// Existing server with changed connection config,
			// or an unauthenticated server whose OAuth tokens just appeared in the settings
			// file (e.g. the CLI or another window completed authorization for it)
			try {
				// Set status to "connecting" and notify webview before restart (same pattern as restartConnection)
				currentConnection.server.status = "connecting"
				currentConnection.server.error = ""
				await host.notifyWebviewOfServerChanges()

				if (config.type === "stdio") {
					setupFileWatcher(host, name, config)
				}
				await host.deleteConnection(name)
				await host.connectToServer(name, config, "internal")
				Logger.log(`Reconnected MCP server with updated config: ${name}`)
				connectionChangesOccurred = true
			} catch (error) {
				Logger.error(`Failed to reconnect MCP server ${name}:`, error)
				// connectToServer registered a disconnected entry carrying
				// the error; the webview must be told about it.
				connectionChangesOccurred = true
			}
		} else {
			// Only PlinyCode-specific settings changed - update in-memory state without restart
			// Don't set connectionChangesOccurred since the RPC already returned the updated state
			const autoApprove = config.autoApprove || []
			if (currentConnection.server.tools) {
				currentConnection.server.tools = currentConnection.server.tools.map((tool) => ({
					...tool,
					autoApprove: autoApprove.includes(tool.name),
				}))
			}
			// Also update PlinyCode-specific settings in the stored config
			const currentConfig = JSON.parse(currentConnection.server.config)
			currentConfig.autoApprove = config.autoApprove
			currentConfig.timeout = config.timeout
			currentConnection.server.config = JSON.stringify(currentConfig)
		}
	}

	// Only notify webview if actual connection changes occurred.
	// For PlinyCode-specific settings changes, the RPC response already updated the webview,
	// so we skip notification to avoid race conditions.
	if (connectionChangesOccurred) {
		await host.notifyWebviewOfServerChanges()
	}
	host.isConnecting = false
}

export interface RestartConnectionHost {
	connections: McpConnection[]
	isConnecting: boolean
	deleteConnection(name: string): Promise<void>
	connectToServer(name: string, config: z.infer<typeof ServerConfigSchema>, source: "rpc" | "internal"): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
	readAndValidateMcpSettingsFile(): Promise<Awaited<ReturnType<typeof readAndValidateMcpSettingsFile>>>
	notifyWebviewOfServerChanges(): Promise<void>
}

export async function restartConnectionRPC(host: RestartConnectionHost, serverName: string): Promise<McpServer[]> {
	host.isConnecting = true

	// Get existing connection and update its status
	const connection = host.connections.find((conn) => conn.server.name === serverName)
	const inMemoryConfig = connection?.server.config
	if (inMemoryConfig) {
		connection.server.status = "connecting"
		connection.server.error = ""
		await setTimeoutPromise(500) // artificial delay to show user that server is restarting
		try {
			await host.deleteConnection(serverName)
			// Try to connect again using existing config
			await host.connectToServer(serverName, JSON.parse(inMemoryConfig), "rpc")
		} catch (error) {
			Logger.error(`Failed to restart connection for ${serverName}:`, error)
		}
	}

	host.isConnecting = false

	const config = await host.readAndValidateMcpSettingsFile()
	if (!config) {
		throw new Error("Failed to read or validate MCP settings")
	}

	const serverOrder = Object.keys(config.mcpServers || {})
	return host.getSortedMcpServers(serverOrder)
}

export async function restartConnection(host: RestartConnectionHost, serverName: string): Promise<void> {
	host.isConnecting = true

	// Get existing connection and update its status
	const connection = host.connections.find((conn) => conn.server.name === serverName)
	const config = connection?.server.config
	if (config) {
		HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `Restarting ${serverName} MCP server...`,
		})
		connection.server.status = "connecting"
		connection.server.error = ""
		await host.notifyWebviewOfServerChanges()
		await setTimeoutPromise(500) // artificial delay to show user that server is restarting
		try {
			await host.deleteConnection(serverName)
			// Try to connect again using existing config
			await host.connectToServer(serverName, JSON.parse(config), "internal")
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: `${serverName} MCP server connected`,
			})
		} catch (error) {
			Logger.error(`Failed to restart connection for ${serverName}:`, error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to connect to ${serverName} MCP server`,
			})
		}
	}

	await host.notifyWebviewOfServerChanges()
	host.isConnecting = false
}

/**
 * Gets sorted MCP servers based on the order defined in settings
 * @param connections The live connections to sort
 * @param serverOrder Array of server names in the order they appear in settings
 * @returns Array of McpServer objects sorted according to settings order
 */
export function getSortedMcpServers(connections: McpConnection[], serverOrder: string[]): McpServer[] {
	return [...connections]
		.sort((a, b) => {
			const indexA = serverOrder.indexOf(a.server.name)
			const indexB = serverOrder.indexOf(b.server.name)
			return indexA - indexB
		})
		.map((connection) => connection.server)
}

export interface NotifyWebviewHost {
	getSettingsDirectoryPath: () => Promise<string>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
	checkToolListChanged(): void
}

export async function notifyWebviewOfServerChanges(host: NotifyWebviewHost): Promise<void> {
	// servers should always be sorted in the order they are defined in the settings file
	const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
	const content = await fs.readFile(settingsPath, "utf-8")
	const config = JSON.parse(content)
	const serverOrder = Object.keys(config.mcpServers || {})

	// Get sorted servers
	const sortedServers = host.getSortedMcpServers(serverOrder)

	// Send update using gRPC stream
	await sendMcpServersUpdate({
		mcpServers: convertMcpServersToProtoMcpServers(sortedServers),
	})

	// Check if the tool list actually changed and notify SDK controller if so
	host.checkToolListChanged()
}

export interface ReconcileHost {
	getSettingsDirectoryPath: () => Promise<string>
	lastConnectionFingerprint?: string
	updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void>
	notifyWebviewOfServerChanges(): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

export async function reconcileMcpServersFromSettingsRPC(host: ReconcileHost): Promise<McpServer[]> {
	const settings = await readPostWriteMcpSettings(host)
	await host.updateServerConnectionsRPC(settings.mcpServers as Record<string, McpServerConfig>)
	await host.notifyWebviewOfServerChanges()

	const serverOrder = Object.keys(settings.mcpServers || {})
	return host.getSortedMcpServers(serverOrder)
}

export interface GetLatestServersHost {
	getSettingsDirectoryPath: () => Promise<string>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

export async function getLatestMcpServersRPC(host: GetLatestServersHost): Promise<McpServer[]> {
	const settings = await readAndValidateMcpSettingsFile(host)
	if (!settings) {
		// Return empty array if settings can't be read or validated
		return []
	}

	const serverOrder = Object.keys(settings.mcpServers || {})
	return host.getSortedMcpServers(serverOrder)
}

export interface ToggleServerDisabledHost {
	isConnecting: boolean
	getSettingsDirectoryPath: () => Promise<string>
	lastConnectionFingerprint?: string
	deleteConnection(name: string): Promise<void>
	connectToServer(name: string, config: z.infer<typeof ServerConfigSchema>, source: "rpc" | "internal"): Promise<void>
	notifyWebviewOfServerChanges(): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

export async function toggleServerDisabledRPC(
	host: ToggleServerDisabledHost,
	serverName: string,
	disabled: boolean,
): Promise<McpServer[]> {
	host.isConnecting = true
	try {
		// Hold the cross-process lock across read-modify-write so a concurrent
		// writer (CLI, OAuth handshake, another window) cannot clobber this
		// toggle. Connection rebuild stays OUTSIDE the lock: connectToServer can
		// trigger SDK OAuth writes that take the same (non-reentrant) lock.
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		await updateMcpSettingsFile(settingsPath, (validated) => {
			const servers = validated.mcpServers as Record<string, any>

			if (!servers[serverName]) {
				throw new Error(`Server "${serverName}" not found in MCP configuration`)
			}

			servers[serverName].disabled = disabled
			validated.mcpServers = servers
			return validated
		})
		const config = await readPostWriteMcpSettings(host)

		// Rebuild the connection so the toggle takes effect. A disabled
		// server's connection is a stub with no live transport/client, so the
		// toggle must route through connectToServer(), which opens a real
		// transport when enabled or creates a disconnected stub when disabled.
		// deleteConnection preserves OAuth state.
		const mcpServers = config.mcpServers as Record<string, McpServerConfig>
		const newConfig = mcpServers[serverName]
		await host.deleteConnection(serverName)
		await host.connectToServer(serverName, newConfig, "rpc")

		// Refresh the SDK session's tool list to reflect the server
		// appearing or disappearing.
		await host.notifyWebviewOfServerChanges()

		const serverOrder = Object.keys(config.mcpServers || {})
		return host.getSortedMcpServers(serverOrder)
	} catch (error) {
		Logger.error("Failed to update server disabled state:", error)
		if (error instanceof Error) {
			Logger.error("Error details:", error.message, error.stack)
		}
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to update server state: ${error instanceof Error ? error.message : String(error)}`,
		})
		throw error
	} finally {
		host.isConnecting = false
	}
}

export interface CallToolHost {
	connections: McpConnection[]
}

export async function callTool(
	host: CallToolHost,
	serverName: string,
	toolName: string,
	toolArguments: Record<string, unknown> | undefined,
	_ulid: string,
	signal?: AbortSignal,
): Promise<McpToolCallResponse> {
	const connection = host.connections.find((conn) => conn.server.name === serverName)
	if (!connection) {
		throw new Error(
			`No connection found for server: ${serverName}. Please make sure to use MCP servers available under 'Connected MCP Servers'.`,
		)
	}

	if (connection.server.disabled) {
		throw new Error(`Server "${serverName}" is disabled and cannot be used`)
	}

	// A failed (re)connect leaves an entry with no client so the server
	// stays visible in the list; a tool wrapper captured by an active
	// session can still target it, and must get a controlled error.
	if (!connection.client) {
		const detail = connection.server.error ? ` Last error: ${connection.server.error}` : ""
		throw new Error(`Server "${serverName}" is not connected and cannot be used.${detail}`)
	}

	// The config is re-resolved on each call, so a changed timeout takes
	// effect on the next request.
	const timeout = resolveMcpServerTimeoutMs(connection.server.config) // sdk expects ms

	try {
		const result = await connection.client.request(
			{
				method: "tools/call",
				params: {
					name: toolName,
					arguments: toolArguments ?? {},
				},
			},
			CallToolResultSchema,
			{
				timeout,
				signal,
			},
		)

		return {
			...result,
			content: result.content ?? [],
		}
	} catch (error) {
		throw augmentMcpTimeoutError(error, serverName, timeout)
	}
}

export interface ToggleToolAutoApproveHost {
	connections: McpConnection[]
	getSettingsDirectoryPath: () => Promise<string>
	recordSettingsFingerprint(servers: Record<string, McpServerConfig>): void
	notifyWebviewOfServerChanges(): Promise<void>
}

/**
 * RPC variant of toggleToolAutoApprove that returns the updated servers instead of notifying the webview
 * @param serverName The name of the MCP server
 * @param toolNames Array of tool names to toggle auto-approve for
 * @param shouldAllow Whether to enable or disable auto-approve
 * @returns Array of updated MCP servers
 */
export async function toggleToolAutoApproveRPC(
	host: ToggleToolAutoApproveHost & { getSortedMcpServers(serverOrder: string[]): McpServer[] },
	serverName: string,
	toolNames: string[],
	shouldAllow: boolean,
): Promise<McpServer[]> {
	try {
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		const { config, autoApprove } = await updateMcpSettingsFile(settingsPath, (parsed) => {
			// Initialize autoApprove if it doesn't exist
			const servers = parsed.mcpServers as Record<string, any>
			if (!servers[serverName].autoApprove) {
				servers[serverName].autoApprove = []
			}

			const approve = servers[serverName].autoApprove
			for (const toolName of toolNames) {
				const toolIndex = approve.indexOf(toolName)

				if (shouldAllow && toolIndex === -1) {
					// Add tool to autoApprove list
					approve.push(toolName)
				} else if (!shouldAllow && toolIndex !== -1) {
					// Remove tool from autoApprove list
					approve.splice(toolIndex, 1)
				}
			}
			return { config: parsed, autoApprove: approve }
		})
		host.recordSettingsFingerprint(config.mcpServers as Record<string, McpServerConfig>)

		// Update the tools list to reflect the change
		const connection = host.connections.find((conn) => conn.server.name === serverName)
		if (connection && connection.server.tools) {
			// Update the autoApprove property of each tool in the in-memory server object
			connection.server.tools = connection.server.tools.map((tool) => ({
				...tool,
				autoApprove: autoApprove.includes(tool.name),
			}))
		}

		// Return sorted servers without notifying webview
		const serverOrder = Object.keys(config.mcpServers || {})
		return host.getSortedMcpServers(serverOrder)
	} catch (error) {
		Logger.error("Failed to update autoApprove settings:", error)
		throw error // Re-throw to ensure the error is properly handled
	}
}

export async function toggleToolAutoApprove(
	host: ToggleToolAutoApproveHost,
	serverName: string,
	toolNames: string[],
	shouldAllow: boolean,
): Promise<void> {
	try {
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		const { autoApprove, mcpServers } = await updateMcpSettingsFile(settingsPath, (config) => {
			// Initialize autoApprove if it doesn't exist
			const servers = config.mcpServers as Record<string, any>
			if (!servers[serverName].autoApprove) {
				servers[serverName].autoApprove = []
			}

			const approve = servers[serverName].autoApprove
			for (const toolName of toolNames) {
				const toolIndex = approve.indexOf(toolName)

				if (shouldAllow && toolIndex === -1) {
					// Add tool to autoApprove list
					approve.push(toolName)
				} else if (!shouldAllow && toolIndex !== -1) {
					// Remove tool from autoApprove list
					approve.splice(toolIndex, 1)
				}
			}
			return { autoApprove: approve as string[], mcpServers: servers as Record<string, McpServerConfig> }
		})
		host.recordSettingsFingerprint(mcpServers)

		// Update the tools list to reflect the change
		const connection = host.connections.find((conn) => conn.server.name === serverName)
		if (connection && connection.server.tools) {
			// Update the autoApprove property of each tool in the in-memory server object
			connection.server.tools = connection.server.tools.map((tool) => ({
				...tool,
				autoApprove: autoApprove.includes(tool.name),
			}))
			await host.notifyWebviewOfServerChanges()
		}
	} catch (error) {
		Logger.error("Failed to update autoApprove settings:", error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: "Failed to update autoApprove settings",
		})
		throw error // Re-throw to ensure the error is properly handled
	}
}

export interface AddRemoteServerHost {
	getSettingsDirectoryPath: () => Promise<string>
	lastConnectionFingerprint?: string
	updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

export async function addRemoteServer(
	host: AddRemoteServerHost,
	serverName: string,
	serverUrl: string,
	transportType = "streamableHttp",
): Promise<McpServer[]> {
	try {
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		await updateMcpSettingsFile(settingsPath, (current) => {
			const servers = current.mcpServers as Record<string, any>
			if (servers[serverName]) {
				throw new Error(`An MCP server with the name "${serverName}" already exists`)
			}

			const serverConfig = {
				url: serverUrl,
				type: transportType,
				disabled: false,
				autoApprove: [],
			}

			// Expand environment variables for validation
			const expandedConfig = expandEnvironmentVariables(serverConfig)

			const urlValidation = z.string().url().safeParse(expandedConfig.url)
			if (!urlValidation.success) {
				throw new Error(`Invalid server URL: ${expandedConfig.url}. Please provide a valid URL.`)
			}

			const parsedConfig = ServerConfigSchema.parse(expandedConfig)

			servers[serverName] = parsedConfig

			// We don't write the zod-transformed version to the file.
			// The above parse() call adds the transportType field to the server config
			// It would be fine if this was written, but we don't want to clutter up the file with internal details

			// ToDo: We could benefit from input / output types reflecting the non-transformed / transformed versions
			const serversToWrite = { ...servers, [serverName]: serverConfig }
			current.mcpServers = serversToWrite
			return current
		})
		const settings = await readPostWriteMcpSettings(host)

		await host.updateServerConnectionsRPC(settings.mcpServers as Record<string, McpServerConfig>)

		const serverOrder = Object.keys(settings.mcpServers || {})
		return host.getSortedMcpServers(serverOrder)
	} catch (error) {
		Logger.error("Failed to add remote MCP server:", error)
		throw error
	}
}

export interface DeleteServerRPCHost {
	clearOAuthForConnection(name: string): Promise<void>
	getSettingsDirectoryPath: () => Promise<string>
	lastConnectionFingerprint?: string
	updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

/**
 * RPC variant of deleteServer that returns the updated server list directly
 * @param serverName The name of the server to delete
 * @returns Array of remaining MCP servers
 */
export async function deleteServerRPC(host: DeleteServerRPCHost, serverName: string): Promise<McpServer[]> {
	try {
		// Clear OAuth data BEFORE removing from config (while we still have the connection/URL)
		await host.clearOAuthForConnection(serverName)

		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		await updateMcpSettingsFile(settingsPath, (parsed) => {
			const servers = parsed.mcpServers as Record<string, any>

			if (!servers[serverName]) {
				throw new Error(`${serverName} not found in MCP configuration`)
			}

			delete servers[serverName]
			parsed.mcpServers = servers
			return parsed
		})
		const config = await readPostWriteMcpSettings(host)
		const mcpServers = config.mcpServers as Record<string, McpServerConfig>

		await host.updateServerConnectionsRPC(mcpServers)

		// Get the servers in their correct order from settings
		const serverOrder = Object.keys(mcpServers || {})
		return host.getSortedMcpServers(serverOrder)
	} catch (error) {
		Logger.error(`Failed to delete MCP server: ${error instanceof Error ? error.message : String(error)}`)
		throw error
	}
}

export interface UpdateServerTimeoutRPCHost {
	getSettingsDirectoryPath: () => Promise<string>
	lastConnectionFingerprint?: string
	updateServerConnectionsRPC(newServers: Record<string, McpServerConfig>): Promise<void>
	getSortedMcpServers(serverOrder: string[]): McpServer[]
}

export async function updateServerTimeoutRPC(
	host: UpdateServerTimeoutRPCHost,
	serverName: string,
	timeout: number,
): Promise<McpServer[]> {
	try {
		// Validate timeout against schema
		const setConfigResult = McpTimeoutSecondsSchema.safeParse(timeout)
		if (!setConfigResult.success) {
			throw new Error(
				`Invalid timeout value: ${timeout}. The "timeout" field must be a finite number from ` +
					`${MIN_MCP_TIMEOUT_SECONDS} to ${MAX_MCP_TIMEOUT_SECONDS} seconds.`,
			)
		}

		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		await updateMcpSettingsFile(settingsPath, (parsed) => {
			const servers = parsed.mcpServers as Record<string, any>

			if (!servers[serverName]) {
				throw new Error(`Server "${serverName}" not found in settings`)
			}

			servers[serverName] = {
				...servers[serverName],
				timeout,
			}

			parsed.mcpServers = servers
			return parsed
		})
		const config = await readPostWriteMcpSettings(host)
		await host.updateServerConnectionsRPC(config.mcpServers as Record<string, McpServerConfig>)

		const serverOrder = Object.keys(config.mcpServers || {})
		return host.getSortedMcpServers(serverOrder)
	} catch (error) {
		Logger.error("Failed to update server timeout:", error)
		if (error instanceof Error) {
			Logger.error("Error details:", error.message, error.stack)
		}
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to update server timeout: ${error instanceof Error ? error.message : String(error)}`,
		})
		throw error
	}
}

export interface InitiateOAuthHost {
	connections: McpConnection[]
	mcpOAuthManager: McpOAuthManager
	notifyWebviewOfServerChanges(): Promise<void>
	appendErrorMessage(connection: McpConnection, error: string): void
	restartConnection(serverName: string): Promise<void>
}

/**
 * Runs the complete OAuth flow for a server when the user clicks
 * "Authenticate".
 *
 * The interactive flow is HTTP-based token collection (the same flow the CLI
 * uses): a local loopback callback server is bound, the browser is opened to
 * the authorization URL, and the code is exchanged in-process with the OAuth
 * state validated against the value generated for this flow. Tokens are
 * written to the shared MCP settings file, so the CLI and other windows see
 * them immediately. On success the connection is restarted so the transport
 * picks up the fresh tokens.
 */
export async function initiateOAuth(host: InitiateOAuthHost, serverName: string): Promise<void> {
	const connection = host.connections.find((conn) => conn.server.name === serverName)
	if (!connection) {
		throw new Error(`No connection found for server: ${serverName}`)
	}

	// Show "pending" in the UI while the user is off in the browser
	connection.server.oauthAuthStatus = "pending"
	connection.server.error = ""
	await host.notifyWebviewOfServerChanges()

	try {
		// Blocks until tokens are exchanged and written to the settings file
		await host.mcpOAuthManager.startOAuthFlow(serverName)
	} catch (error) {
		const current = host.connections.find((conn) => conn.server.name === serverName)
		if (current) {
			current.server.oauthAuthStatus = "unauthenticated"
			host.appendErrorMessage(current, error instanceof Error ? error.message : String(error))
		}
		await host.notifyWebviewOfServerChanges()
		throw error
	}

	Logger.log(`[McpOAuth] Authentication completed for ${serverName}`)

	const authedConnection = host.connections.find((conn) => conn.server.name === serverName)
	if (authedConnection) {
		authedConnection.server.oauthAuthStatus = "authenticated"
		authedConnection.server.oauthRequired = true
		authedConnection.server.error = ""
	}

	// Restart connection so the transport authenticates with the new tokens
	await host.restartConnection(serverName)
}
