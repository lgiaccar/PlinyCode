import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
	PromptListChangedNotificationSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import chokidar, { type FSWatcher } from "chokidar"
import ReconnectingEventSource from "reconnecting-eventsource"
import { z } from "zod"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { expandEnvironmentVariables } from "@/utils/envExpansion"
import type { McpOAuthManager } from "./McpOAuthManager"
import { configsRequireRestart, readAndValidateMcpSettingsFile } from "./mcp-settings-store"
import { StreamableHttpReconnectHandler } from "./StreamableHttpReconnectHandler"
import type { ServerConfigSchema } from "./schemas"
import { augmentMcpTimeoutError, resolveMcpServerTimeoutMs } from "./timeout"
import type { McpConnection, McpServerConfig, Transport } from "./types"

/**
 * The subset of McpHub's state and behavior that connectToServer and the
 * per-server stdio file watchers need. Passed explicitly rather than owned
 * here, so the fields keep living directly on the McpHub instance (tests
 * build partial McpHub instances and poke these fields/methods directly).
 */
export interface TransportFactoryHost {
	connections: McpConnection[]
	clientVersion: string
	mcpOAuthManager: McpOAuthManager
	fileWatchers: Map<string, FSWatcher>
	notificationCallback?: (serverName: string, level: string, message: string) => void
	pendingNotifications: Array<{
		serverName: string
		level: string
		message: string
		timestamp: number
	}>
	getSettingsDirectoryPath: () => Promise<string>
	findConnection(name: string, source: "rpc" | "internal"): McpConnection | undefined
	appendErrorMessage(connection: McpConnection, error: string): void
	notifyWebviewOfServerChanges(): Promise<void>
	fetchServerCapabilities(connection: McpConnection): Promise<void>
	deleteConnection(name: string): Promise<void>
	restartConnection(serverName: string): Promise<void>
	scheduleListChangedRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): void
	connectToServer(name: string, config: z.infer<typeof ServerConfigSchema>, source: "rpc" | "internal"): Promise<void>
}

export async function connectToServer(
	host: TransportFactoryHost,
	name: string,
	config: z.infer<typeof ServerConfigSchema>,
	source: "rpc" | "internal",
): Promise<void> {
	// Remove existing connection if it exists (should never happen, the connection should be deleted beforehand)
	host.connections = host.connections.filter((conn) => conn.server.name !== name)

	if (config.disabled) {
		//Logger.log(`[MCP Debug] Creating disabled connection object for server "${name}"`)
		// Create a connection object for disabled server so it appears in UI
		const disabledConnection: McpConnection = {
			server: {
				name,
				config: JSON.stringify(config),
				status: "disconnected",
				disabled: true,
			},
			client: null as unknown as Client,
			transport: null as unknown as Transport,
		}
		host.connections.push(disabledConnection)
		return
	}

	try {
		// Store unexpanded config for display/comparison (keeps credentials out of stored config)
		const configForStorage = JSON.stringify(config)

		// Expand environment variables in config before using it
		const expandedConfig = expandEnvironmentVariables(config)

		// Each MCP server requires its own transport connection and has unique capabilities, configurations, and error handling. Having separate clients also allows proper scoping of resources/tools and independent server management like reconnection.
		const client = new Client(
			{
				name: "PlinyCode",
				version: host.clientVersion,
			},
			{
				capabilities: {},
			},
		)

		let transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport

		// Create OAuth provider for remote transports (SSE and HTTP)
		const authProvider =
			expandedConfig.type === "sse" || expandedConfig.type === "streamableHttp"
				? await host.mcpOAuthManager.getOrCreateProvider(name, expandedConfig.url)
				: undefined

		switch (expandedConfig.type) {
			case "stdio": {
				transport = new StdioClientTransport({
					command: expandedConfig.command,
					args: expandedConfig.args,
					cwd: expandedConfig.cwd,
					env: {
						...getDefaultEnvironment(),
						...(expandedConfig.env || {}), // Now has expanded environment variables
					},
					stderr: "pipe",
				})

				transport.onerror = async (error) => {
					Logger.error(`Transport error for "${name}":`, error)
					const connection = host.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						host.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					// onerror's promise is discarded, so a rejection here
					// would surface as an unhandled rejection
					await host.notifyWebviewOfServerChanges().catch((notifyError) => {
						Logger.error(`Failed to publish server state for "${name}":`, notifyError)
					})
				}

				transport.onclose = async () => {
					const connection = host.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
					}
					await host.notifyWebviewOfServerChanges()
				}

				await transport.start()
				const stderrStream = transport.stderr
				if (stderrStream) {
					stderrStream.on("data", async (data: Buffer) => {
						const output = data.toString()
						const isInfoLog = !/\berror\b/i.test(output)

						if (isInfoLog) {
							Logger.log(`Server "${name}" info:`, output)
						} else {
							Logger.error(`Server "${name}" stderr:`, output)
							const connection = host.findConnection(name, source)
							if (connection) {
								host.appendErrorMessage(connection, output)
								if (connection.server.status === "disconnected") {
									await host.notifyWebviewOfServerChanges()
								}
							}
						}
					})
				} else {
					Logger.error(`No stderr stream for ${name}`)
				}
				transport.start = async () => {}
				break
			}
			case "sse": {
				const sseOptions = {
					authProvider,
					requestInit: {
						headers: expandedConfig.headers,
					},
				}
				const reconnectingEventSourceOptions = {
					max_retry_time: 5000,
					withCredentials: !!expandedConfig.headers?.["Authorization"],
					// IMPORTANT: Custom fetch function is required for SSE with OAuth
					// When we provide eventSourceInit, we override the SDK's default fetch
					// The SDK's default would call _commonHeaders() for auth, but since we're
					// overriding it, we must provide our own fetch that:
					// 1. Calls authProvider.tokens() dynamically (not captured once)
					// 2. Gets fresh tokens for each connection/reconnection
					// 3. Allows the SDK to auto-refresh expired tokens
					// Without this, tokens would be stale and fail after expiry
					fetch: authProvider
						? async (url: string | URL, init?: RequestInit) => {
								const tokens = await authProvider.tokens() // Dynamic - gets fresh tokens
								const headers = new Headers(init?.headers)
								if (tokens?.access_token) {
									headers.set("Authorization", `Bearer ${tokens.access_token}`)
								}
								return fetch(url.toString(), { ...init, headers })
							}
						: undefined,
				}
				// Use ReconnectingEventSource for auto-reconnection on connection drops
				global.EventSource = ReconnectingEventSource
				transport = new SSEClientTransport(new URL(expandedConfig.url), {
					...sseOptions,
					eventSourceInit: reconnectingEventSourceOptions,
				})

				transport.onerror = async (error) => {
					Logger.error(`Transport error for "${name}":`, error)
					const connection = host.findConnection(name, source)
					if (connection) {
						connection.server.status = "disconnected"
						host.appendErrorMessage(connection, error instanceof Error ? error.message : `${error}`)
					}
					// onerror's promise is discarded, so a rejection here
					// would surface as an unhandled rejection
					await host.notifyWebviewOfServerChanges().catch((notifyError) => {
						Logger.error(`Failed to publish server state for "${name}":`, notifyError)
					})
				}
				break
			}
			case "streamableHttp": {
				// Use ReconnectingEventSource for auto-reconnection on connection drops
				global.EventSource = ReconnectingEventSource

				// Custom fetch wrapper that treats 404 as 405 for GET requests.
				// The MCP SDK sends a GET request to check for SSE stream support.
				// Per MCP spec, servers should return 405 if they don't support SSE,
				// but many servers (incorrectly) return 404. The SDK only handles 405
				// gracefully, so we normalize 404 -> 405 to fix compatibility.
				// See: https://github.com/modelcontextprotocol/typescript-sdk/issues/1150
				const streamableHttpFetch = (async (url, init) => {
					const response = await fetch(url, init)
					if (init?.method === "GET" && response.status === 404) {
						return new Response(response.body, {
							status: 405,
							statusText: "Method Not Allowed",
							headers: response.headers,
						})
					}
					return response
				}) as typeof fetch

				transport = new StreamableHTTPClientTransport(new URL(expandedConfig.url), {
					authProvider,
					requestInit: {
						headers: expandedConfig.headers ?? undefined,
					},
					fetch: streamableHttpFetch,
				})

				const reconnectHandler = new StreamableHttpReconnectHandler(name, {
					findConnection: () => host.findConnection(name, source),
					deleteConnection: () => host.deleteConnection(name),
					connectToServer: () => host.connectToServer(name, config, source),
					notifyWebviewOfServerChanges: () => host.notifyWebviewOfServerChanges(),
					appendErrorMessage: (conn, msg) => host.appendErrorMessage(conn as McpConnection, msg),
					delay: (ms) => setTimeoutPromise(ms),
					isStillWanted: async () => {
						const settings = await readAndValidateMcpSettingsFile(host)
						if (!settings) {
							// Can't read settings — don't kill the reconnect
							// chain over a transient read failure
							return true
						}
						const serverConfig = (settings.mcpServers as Record<string, McpServerConfig> | undefined)?.[name]
						if (!serverConfig || serverConfig.disabled) {
							return false
						}
						// A retry reconnects with the config captured when this
						// connection was created. If settings now define a
						// different connection-relevant config, the settings
						// watcher owns reconnection — retrying here would
						// resurrect the obsolete config (and displace the
						// watcher's failed attempt at the new one).
						return !configsRequireRestart(config, serverConfig)
					},
				})

				transport.onerror = (error) => reconnectHandler.handleError(error)
				break
			}
			default:
				throw new Error(`Unknown transport type: ${(config as any).type}`)
		}

		const connection: McpConnection = {
			server: {
				name,
				config: configForStorage,
				status: "connecting",
				disabled: config.disabled,
				oauthRequired: false,
				oauthAuthStatus: "authenticated",
			},
			client,
			transport,
			authProvider,
		}
		host.connections.push(connection)

		// Connect - wrap in try-catch to detect OAuth requirement
		try {
			const timeout = resolveMcpServerTimeoutMs(connection.server.config)
			await client.connect(transport, { timeout })
		} catch (error) {
			if (error instanceof UnauthorizedError) {
				// Server requires OAuth authentication
				Logger.log(`Server "${name}" requires OAuth authentication`)
				const unauthConnection: McpConnection = {
					server: {
						name,
						config: JSON.stringify(config),
						status: "disconnected",
						disabled: false,
						oauthRequired: true,
						oauthAuthStatus: "unauthenticated",
						error: "This MCP server requires authentication to get started.",
					},
					client,
					transport,
					authProvider, // CRITICAL: Keep authProvider so it's available when user authenticates!
				}
				// Replace the connection with unauthenticated version
				host.connections = host.connections.filter((conn) => conn.server.name !== name)
				host.connections.push(unauthConnection)
				await host.notifyWebviewOfServerChanges()
				return // Don't throw, just mark as needs auth
			}
			await client.close().catch(() => {})
			// Re-throw other errors with the same actionable timeout detail as
			// post-initialize requests.
			throw augmentMcpTimeoutError(error, name, resolveMcpServerTimeoutMs(connection.server.config))
		}

		connection.server.status = "connected"
		connection.server.error = ""

		// Register notification handler for real-time messages
		//Logger.log(`[MCP Debug] Setting up notification handlers for server: ${name}`)
		//Logger.log(`[MCP Debug] Client instance:`, connection.client)
		//Logger.log(`[MCP Debug] Transport type:`, config.type)

		// Try to set notification handler using the client's method
		try {
			// Import the notification schema from MCP SDK
			const { z } = await import("zod")

			// Define the notification schema for notifications/message
			const NotificationMessageSchema = z.object({
				method: z.literal("notifications/message"),
				params: z
					.object({
						level: z.enum(["debug", "info", "warning", "error"]).optional(),
						logger: z.string().optional(),
						data: z.string().optional(),
						message: z.string().optional(),
					})
					.optional(),
			})

			// Set the notification handler
			connection.client.setNotificationHandler(NotificationMessageSchema as any, async (notification: any) => {
				//Logger.log(`[MCP Notification] ${name}:`, JSON.stringify(notification, null, 2))

				const params = notification.params || {}
				const level = params.level || "info"
				const data = params.data || params.message || ""
				const logger = params.logger || ""

				//Logger.log(`[MCP Message Notification] ${name}: level=${level}, data=${data}, logger=${logger}`)

				// Format the message
				const message = logger ? `[${logger}] ${data}` : data

				// Send notification directly to active task if callback is set
				if (host.notificationCallback) {
					//Logger.log(`[MCP Debug] Sending notification to active task: ${message}`)
					host.notificationCallback(name, level, message)
				} else {
					// Fallback: store for later retrieval
					//Logger.log(`[MCP Debug] No active task, storing notification: ${message}`)
					host.pendingNotifications.push({
						serverName: name,
						level,
						message,
						timestamp: Date.now(),
					})
				}
			})
			//Logger.log(`[MCP Debug] Successfully set notifications/message handler for ${name}`)

			// When the server reports that a list changed, refresh the cached
			// list instead of surfacing the notification to the user.
			connection.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				host.scheduleListChangedRefresh(name, "tools")
			})
			connection.client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
				host.scheduleListChangedRefresh(name, "resources")
			})
			connection.client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
				host.scheduleListChangedRefresh(name, "prompts")
			})

			// Log any other unhandled notification types instead of toasting
			// them: servers can emit these at any time and a toast per
			// notification quickly floods the user.
			connection.client.fallbackNotificationHandler = async (notification: any) => {
				Logger.log(
					`[MCP] ${name}: unhandled notification ${notification.method || "unknown"} - ${JSON.stringify(notification.params || {})}`,
				)
			}
		} catch (error) {
			Logger.error(`[MCP Debug] Error setting notification handlers for ${name}:`, error)
		}

		// Initial fetch of tools, resources, and prompts
		await host.fetchServerCapabilities(connection)
	} catch (error) {
		// Update status with error. A failure before the connection was
		// registered (e.g. the transport failed to start) must still leave
		// an entry, so the server stays visible in the list with its error
		// rather than silently disappearing.
		let connection = host.findConnection(name, source)
		if (!connection) {
			connection = {
				server: {
					name,
					config: JSON.stringify(config),
					status: "disconnected",
					disabled: config.disabled,
				},
				client: null as unknown as Client,
				transport: null as unknown as Transport,
			}
			host.connections.push(connection)
		}
		connection.server.status = "disconnected"
		host.appendErrorMessage(connection, error instanceof Error ? error.message : String(error))
		throw error
	}
}

/**
 * The subset of McpHub's state needed by the per-server stdio file watchers,
 * which restart a server when its build output changes on disk.
 */
export interface FileWatcherHost {
	fileWatchers: Map<string, FSWatcher>
	restartConnection(serverName: string): Promise<void>
}

export function setupFileWatcher(host: FileWatcherHost, name: string, config: Extract<McpServerConfig, { type: "stdio" }>) {
	const filePath = config.args?.find((arg: string) => arg.includes("build/index.js"))
	if (filePath) {
		// we use chokidar instead of onDidSaveTextDocument because it doesn't require the file to be open in the editor. The settings config is better suited for onDidSave since that will be manually updated by the user or PlinyCode (and we want to detect save events, not every file change)
		const watcher = chokidar.watch(filePath, {
			// persistent: true,
			// ignoreInitial: true,
			// awaitWriteFinish: true, // This helps with atomic writes
		})

		watcher.on("change", () => {
			Logger.log(`Detected change in ${filePath}. Restarting server ${name}...`)
			host.restartConnection(name)
		})

		host.fileWatchers.set(name, watcher)
	}
}

export function removeAllFileWatchers(host: Pick<FileWatcherHost, "fileWatchers">) {
	host.fileWatchers.forEach((watcher) => {
		watcher.close()
	})
	host.fileWatchers.clear()
}
