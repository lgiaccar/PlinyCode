import { getMcpSettingsFilePath as getMcpSettingsFilePathHelper } from "@core/storage/disk"
import chokidar, { type FSWatcher } from "chokidar"
import deepEqual from "fast-deep-equal"
import * as fs from "fs/promises"
import { z } from "zod"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"
import { expandEnvironmentVariables } from "@/utils/envExpansion"
import { McpSettingsSchema } from "./schemas"
import type { McpConnection, McpServerConfig } from "./types"

/**
 * Deterministic JSON.stringify that sorts object keys, so semantically equal
 * values always produce the same string regardless of key insertion order.
 * Used to fingerprint state for change detection (see computeToolFingerprint
 * in McpHub and computeConnectionFingerprint below).
 */
export function stableJsonStringify(value: unknown): string {
	if (value === undefined) {
		return "null"
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value)
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableJsonStringify).join(",")}]`
	}
	return `{${Object.entries(value as Record<string, unknown>)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableJsonStringify(entryValue)}`)
		.join(",")}}`
}

/**
 * The subset of McpHub's state and behavior that the settings-store functions
 * below need. Passed explicitly (rather than owned by a class here) so the
 * fields keep living directly on the McpHub instance — tests build partial
 * McpHub instances via `Object.create(McpHub.prototype)` and poke these
 * fields/methods directly, so they must stay own-properties of McpHub.
 */
export interface McpSettingsStoreHost {
	getSettingsDirectoryPath: () => Promise<string>
	settingsWatcher?: FSWatcher
	lastConnectionFingerprint?: string
	updateServerConnections(newServers: Record<string, McpServerConfig>): Promise<void>
}

/**
 * Gets the path to the MCP settings file
 * @returns Path to the MCP settings file
 */
export async function getMcpSettingsFilePath(host: Pick<McpSettingsStoreHost, "getSettingsDirectoryPath">): Promise<string> {
	return getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
}

/**
 * Record the post-write connection fingerprint so this window's watcher treats
 * its own write as a no-op. This does not write the settings file.
 */
export function recordSettingsFingerprint(
	host: Pick<McpSettingsStoreHost, "lastConnectionFingerprint">,
	servers: Record<string, McpServerConfig>,
): void {
	host.lastConnectionFingerprint = computeConnectionFingerprint(servers)
}

export async function readPostWriteMcpSettings(
	host: Pick<McpSettingsStoreHost, "getSettingsDirectoryPath" | "lastConnectionFingerprint">,
): Promise<z.infer<typeof McpSettingsSchema>> {
	const settings = await readAndValidateMcpSettingsFile(host)
	if (!settings) {
		throw new Error("Failed to read or validate MCP settings after write")
	}
	recordSettingsFingerprint(host, settings.mcpServers as Record<string, McpServerConfig>)
	return settings
}

export async function readAndValidateMcpSettingsFile(
	host: Pick<McpSettingsStoreHost, "getSettingsDirectoryPath">,
): Promise<z.infer<typeof McpSettingsSchema> | undefined> {
	try {
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		const content = await fs.readFile(settingsPath, "utf-8")

		let config: any

		// Handle empty or minimal files silently - this is a valid state meaning "no MCP servers"
		const trimmedContent = content.trim()
		if (!trimmedContent || trimmedContent === "{}" || trimmedContent === '{"mcpServers":{}}') {
			return { mcpServers: {} }
		}

		// Parse JSON file content
		try {
			config = JSON.parse(content)
		} catch (_error) {
			HostProvider.window
				.showMessage({
					type: ShowMessageType.ERROR,
					message: `Invalid JSON in MCP settings file. Please check the syntax.`,
					options: {
						detail: settingsPath,
						items: ["Open Settings File"],
					},
				})
				.then((response) => {
					if (response.selectedOption === "Open Settings File") {
						HostProvider.window.showTextDocument({
							path: settingsPath,
							options: {},
						})
					}
				})
			return undefined
		}

		// Expand environment variables before validation
		// This allows ${env:VAR_NAME} syntax in URLs, headers, env vars, etc.
		config = expandEnvironmentVariables(config)

		// Validate against schema
		const result = McpSettingsSchema.safeParse(config)
		if (!result.success) {
			// Build a human-readable summary of what failed.
			// Zod paths look like ["mcpServers", "linear", "transport", "url"] — we want to surface
			// the server name (index 1) and the field path so users know exactly what to fix.
			const issuesByServer = new Map<string, string[]>()
			for (const issue of result.error.issues) {
				// path[0] === "mcpServers", path[1] === serverName
				const serverName = issue.path.length >= 2 ? String(issue.path[1]) : "(unknown server)"
				const fieldPath = issue.path.slice(2).join(".") // e.g. "transport.url" or "command"
				const detail = fieldPath ? `${fieldPath}: ${issue.message}` : issue.message
				if (!issuesByServer.has(serverName)) {
					issuesByServer.set(serverName, [])
				}
				issuesByServer.get(serverName)!.push(detail)
			}

			const serverSummaries = Array.from(issuesByServer.entries())
				.map(([server, details]) => `  • ${server}: ${details.join(", ")}`)
				.join("\n")

			HostProvider.window
				.showMessage({
					type: ShowMessageType.ERROR,
					message: `MCP settings schema error — no servers were loaded.`,
					options: {
						detail: `${settingsPath}\n\n${serverSummaries}`,
						modal: false,
						items: ["Open Settings File"],
					},
				})
				.then((response) => {
					if (response.selectedOption === "Open Settings File") {
						HostProvider.window.showTextDocument({
							path: settingsPath,
							options: {},
						})
					}
				})
			return undefined
		}

		return result.data
	} catch (error) {
		Logger.error("Failed to read MCP settings:", error)
		return undefined
	}
}

export async function watchMcpSettingsFile(host: McpSettingsStoreHost): Promise<void> {
	const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())

	host.settingsWatcher = chokidar.watch(settingsPath, {
		persistent: true, // Keep the process running as long as files are being watched
		ignoreInitial: true, // Don't fire 'add' events when discovering the file initially
		awaitWriteFinish: {
			// Wait for writes to finish before emitting events (handles chunked writes)
			stabilityThreshold: 100, // Wait 100ms for file size to remain constant
			pollInterval: 100, // Check file size every 100ms while waiting for stability
		},
		atomic: true, // Handle atomic writes where editors write to a temp file then rename (prevents duplicate events)
	})

	host.settingsWatcher.on("change", async () => {
		const settings = await readAndValidateMcpSettingsFile(host)
		if (settings) {
			// Skip when nothing connection-relevant changed. This covers our own
			// writes (callers pre-seed the fingerprint) as well as
			// OAuth-handshake churn from the SDK (codeVerifier/clientInformation
			// rewrites on every connect attempt for unauthenticated servers). A
			// write from the CLI or another window that genuinely changes a
			// server, or a token appearing/disappearing, produces a different
			// fingerprint and is processed normally.
			const fingerprint = computeConnectionFingerprint(settings.mcpServers as Record<string, McpServerConfig>)
			if (fingerprint === host.lastConnectionFingerprint) {
				return
			}
			host.lastConnectionFingerprint = fingerprint

			try {
				await host.updateServerConnections(settings.mcpServers)
			} catch (error) {
				Logger.error("Failed to process MCP settings change:", error)
			}
		}
	})

	host.settingsWatcher.on("error", (error) => {
		Logger.error("Error watching MCP settings file:", error)
	})
}

/**
 * Compares two MCP server configs to determine if a restart is required.
 * Excludes PlinyCode-specific settings that don't affect the MCP client.
 *
 * ## PlinyCode-specific settings (don't require restart):
 * - `autoApprove`: tool approval list (UI setting)
 *
 * ## MCP client settings (require restart):
 * - `type`, `command`, `args`, `cwd`, `env`, `url`, `headers`, `disabled`, `timeout`
 *
 * ## Adding new PlinyCode-specific settings:
 * When adding a new setting that doesn't require server restart:
 * 1. Add it to the destructuring below to exclude from comparison
 * 2. Add it to computeConnectionFingerprint() if a change to it should (or
 *    should not) wake the settings watcher
 * 3. Update in-memory state (e.g., `connection.server.config`) in the update function
 * 4. Update the schema in `src/services/mcp/schemas.ts` if needed
 */
export function configsRequireRestart(oldConfig: McpServerConfig, newConfig: McpServerConfig): boolean {
	// Exclude PlinyCode-specific settings from comparison (add new ones here).
	// `oauth` and `metadata` are also excluded: the server's oauth block is
	// rewritten on every token save/refresh (by this process, the CLI, or
	// another window), and restarting on each refresh would churn the
	// connection. Token changes are picked up separately, by
	// serverGainedOAuthTokens in updateServerConnections.
	const {
		autoApprove: _oldAutoApprove,
		remoteConfigured: _oldRemoteConfigured,
		oauth: _oldOauth,
		metadata: _oldMetadata,
		...oldConnectionConfig
	} = oldConfig as McpServerConfig & { oauth?: unknown; metadata?: unknown }
	const {
		autoApprove: _newAutoApprove,
		remoteConfigured: _newRemoteConfigured,
		oauth: _newOauth,
		metadata: _newMetadata,
		...newConnectionConfig
	} = newConfig as McpServerConfig & { oauth?: unknown; metadata?: unknown }
	return !deepEqual(oldConnectionConfig, newConnectionConfig)
}

/**
 * True when an unauthenticated server's settings entry now carries an access
 * token — e.g. the CLI or another window completed OAuth for it. The settings
 * watcher uses this to reconnect the server so it picks up the credentials.
 */
export function serverGainedOAuthTokens(connection: McpConnection, newConfig: McpServerConfig): boolean {
	if (connection.server.oauthAuthStatus !== "unauthenticated") {
		return false
	}
	const oauth = (newConfig as McpServerConfig & { oauth?: { tokens?: { access_token?: unknown } } }).oauth
	return typeof oauth?.tokens?.access_token === "string" && oauth.tokens.access_token.length > 0
}

/**
 * Builds a fingerprint of only the parts of the settings file that affect
 * how connections are managed (see lastConnectionFingerprint on McpHub). Per
 * server it captures the full config minus the `oauth` block, plus a single
 * boolean for whether a usable access token exists.
 *
 * Excluding the rest of the `oauth` block means OAuth-handshake churn
 * (codeVerifier, clientInformation, discoveryState, lastError), which the MCP
 * SDK rewrites on every connect attempt, does not change the fingerprint. The
 * access-token boolean is included so that an authorization completing
 * elsewhere (token appears or disappears) does change it.
 */
export function computeConnectionFingerprint(mcpServers: Record<string, McpServerConfig>): string {
	const normalized: Record<string, unknown> = {}
	for (const name of Object.keys(mcpServers).sort()) {
		const { oauth, ...connectionConfig } = mcpServers[name] as McpServerConfig & {
			oauth?: { tokens?: { access_token?: unknown } }
		}
		const accessToken = oauth?.tokens?.access_token
		normalized[name] = {
			config: connectionConfig,
			hasToken: typeof accessToken === "string" && accessToken.length > 0,
		}
	}
	return JSON.stringify(normalized)
}
