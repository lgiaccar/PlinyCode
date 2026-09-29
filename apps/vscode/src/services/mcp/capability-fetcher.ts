import { getMcpSettingsFilePath as getMcpSettingsFilePathHelper } from "@core/storage/disk"
import {
	ErrorCode,
	ListPromptsResultSchema,
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	McpError,
} from "@modelcontextprotocol/sdk/types.js"
import type { McpPrompt, McpResource, McpResourceTemplate, McpTool } from "@shared/mcp"
import * as fs from "fs/promises"
import { Logger } from "@/shared/services/Logger"
import { augmentMcpTimeoutError, resolveMcpServerTimeoutMs } from "./timeout"
import type { McpConnection } from "./types"

// Debounce window that coalesces a burst of list_changed notifications into
// one refresh, the cap on how long a sustained stream of notifications can
// keep deferring that refresh, and the bounded backoff used when the
// refresh's fetch fails.
const LIST_CHANGED_DEBOUNCE_MS = 300
const LIST_CHANGED_MAX_WAIT_MS = 2000
const LIST_CHANGED_MAX_RETRIES = 3
const LIST_CHANGED_RETRY_BASE_DELAY_MS = 1000

/**
 * The subset of McpHub's state and behavior needed by post-connection
 * capability/list discovery and the list_changed debounce/refresh machinery.
 * Passed explicitly rather than owned here, so the fields keep living
 * directly on the McpHub instance (tests build partial McpHub instances and
 * poke these fields/methods directly).
 */
export interface CapabilityFetcherHost {
	connections: McpConnection[]
	getSettingsDirectoryPath: () => Promise<string>
	fetchToolsList(serverName: string): Promise<McpTool[] | undefined>
	fetchResourcesList(serverName: string): Promise<McpResource[] | undefined>
	fetchResourceTemplatesList(serverName: string): Promise<McpResourceTemplate[] | undefined>
	fetchPromptsList(serverName: string): Promise<McpPrompt[] | undefined>
	notifyWebviewOfServerChanges(): Promise<void>
	listChangedRefreshTimers: Map<string, ReturnType<typeof setTimeout>>
	listChangedRefreshInFlight: Map<string, Promise<void>>
	listChangedRefreshGeneration: Map<string, number>
	listChangedRefreshDeadlines: Map<string, number>
}

export function appendErrorMessage(connection: McpConnection, error: string) {
	const newError = connection.server.error ? `${connection.server.error}\n${error}` : error
	connection.server.error = newError //.slice(0, 800)
}

/**
 * Fetches the server's tools, resources, resource templates, and prompts
 * onto the connection. The four list requests run in parallel so a server
 * that hangs after initialize costs one timeout bound rather than four;
 * the MCP client correlates concurrent requests by JSON-RPC id. Each
 * fetch helper swallows its own errors and resolves (undefined on
 * failure, mapped to an empty list here), so a failure in one capability
 * cannot reject the others.
 */
export async function fetchServerCapabilities(host: CapabilityFetcherHost, connection: McpConnection): Promise<void> {
	const name = connection.server.name
	const [tools, resources, resourceTemplates, prompts] = await Promise.all([
		host.fetchToolsList(name),
		host.fetchResourcesList(name),
		host.fetchResourceTemplatesList(name),
		host.fetchPromptsList(name),
	])
	connection.server.tools = tools ?? []
	connection.server.resources = resources ?? []
	connection.server.resourceTemplates = resourceTemplates ?? []
	connection.server.prompts = prompts ?? []
}

/**
 * A server that never declared a capability has an authoritatively empty
 * list for it — not a transient failure worth retrying. Undefined
 * capabilities (not yet negotiated) are treated as supported.
 */
function serverSupports(connection: McpConnection, capability: "tools" | "resources" | "prompts"): boolean {
	const capabilities = connection.client?.getServerCapabilities?.()
	return capabilities === undefined || capabilities[capability] !== undefined
}

/**
 * Like serverSupports, for servers that declare a capability but answer a
 * specific list request with "method not found" (common for
 * resources/templates/list): also an authoritatively empty list.
 */
function isMethodNotFound(error: unknown): boolean {
	return error instanceof McpError && error.code === ErrorCode.MethodNotFound
}

/**
 * Fetches the server's tool list. Returns undefined when the fetch fails,
 * so callers can distinguish an error from a genuinely empty list.
 */
export async function fetchToolsList(host: CapabilityFetcherHost, serverName: string): Promise<McpTool[] | undefined> {
	try {
		const connection = host.connections.find((conn) => conn.server.name === serverName)

		if (!connection) {
			throw new Error(`No connection found for server: ${serverName}`)
		}

		// Disabled servers don't have clients, so return empty tools list
		if (connection.server.disabled || !connection.client) {
			return []
		}

		if (!serverSupports(connection, "tools")) {
			return []
		}

		const response = await connection.client.request({ method: "tools/list" }, ListToolsResultSchema, {
			timeout: resolveMcpServerTimeoutMs(connection.server.config),
		})

		// Get autoApprove settings
		const settingsPath = await getMcpSettingsFilePathHelper(await host.getSettingsDirectoryPath())
		const content = await fs.readFile(settingsPath, "utf-8")
		const config = JSON.parse(content)
		const autoApproveConfig = config.mcpServers[serverName]?.autoApprove || []

		// Mark tools as always allowed based on settings
		const tools = (response?.tools || []).map((tool) => ({
			...tool,
			autoApprove: autoApproveConfig.includes(tool.name),
		}))

		return tools
	} catch (error) {
		if (isMethodNotFound(error)) {
			return []
		}
		const connection = host.connections.find((conn) => conn.server.name === serverName)
		const effectiveError = connection
			? augmentMcpTimeoutError(error, serverName, resolveMcpServerTimeoutMs(connection.server.config))
			: error
		Logger.error(`Failed to fetch tools for ${serverName}:`, effectiveError)
		return undefined
	}
}

/** Returns undefined when the fetch fails (vs. a genuinely empty list). */
export async function fetchResourcesList(host: CapabilityFetcherHost, serverName: string): Promise<McpResource[] | undefined> {
	try {
		const connection = host.connections.find((conn) => conn.server.name === serverName)

		// Disabled servers don't have clients, so return empty resources list
		if (!connection || connection.server.disabled || !connection.client) {
			return []
		}

		if (!serverSupports(connection, "resources")) {
			return []
		}

		const response = await connection.client.request({ method: "resources/list" }, ListResourcesResultSchema, {
			timeout: resolveMcpServerTimeoutMs(connection.server.config),
		})
		return response?.resources || []
	} catch (error) {
		if (isMethodNotFound(error)) {
			return []
		}
		// Logger.error(`Failed to fetch resources for ${serverName}:`, error)
		return undefined
	}
}

/** Returns undefined when the fetch fails (vs. a genuinely empty list). */
export async function fetchResourceTemplatesList(
	host: CapabilityFetcherHost,
	serverName: string,
): Promise<McpResourceTemplate[] | undefined> {
	try {
		const connection = host.connections.find((conn) => conn.server.name === serverName)

		// Disabled servers don't have clients, so return empty resource templates list
		if (!connection || connection.server.disabled || !connection.client) {
			return []
		}

		if (!serverSupports(connection, "resources")) {
			return []
		}

		const response = await connection.client.request(
			{ method: "resources/templates/list" },
			ListResourceTemplatesResultSchema,
			{
				timeout: resolveMcpServerTimeoutMs(connection.server.config),
			},
		)

		return response?.resourceTemplates || []
	} catch (error) {
		if (isMethodNotFound(error)) {
			return []
		}
		// Logger.error(`Failed to fetch resource templates for ${serverName}:`, error)
		return undefined
	}
}

/** Returns undefined when the fetch fails (vs. a genuinely empty list). */
export async function fetchPromptsList(host: CapabilityFetcherHost, serverName: string): Promise<McpPrompt[] | undefined> {
	try {
		const connection = host.connections.find((conn) => conn.server.name === serverName)

		// Disabled servers don't have clients, so return empty prompts list
		if (!connection || connection.server.disabled || !connection.client) {
			return []
		}

		if (!serverSupports(connection, "prompts")) {
			return []
		}

		const response = await connection.client.request({ method: "prompts/list" }, ListPromptsResultSchema, {
			timeout: resolveMcpServerTimeoutMs(connection.server.config),
		})

		return (response?.prompts || []).map((prompt) => ({
			name: prompt.name,
			title: prompt.title,
			description: prompt.description,
			arguments: prompt.arguments?.map((arg) => ({
				name: arg.name,
				description: arg.description,
				required: arg.required,
			})),
		}))
	} catch (error) {
		if (isMethodNotFound(error)) {
			return []
		}
		return undefined
	}
}

/**
 * Debounced entry point for notifications/<kind>/list_changed. Servers
 * emit these in bursts (a toolset change or shutdown can produce a dozen
 * notifications/tools/list_changed at once), so refreshes are coalesced
 * per server and list kind.
 *
 * A refresh whose fetch fails is retried with exponential backoff up to
 * LIST_CHANGED_MAX_RETRIES times: the notification already consumed the
 * server's change signal, so giving up immediately would leave the cached
 * list stale until the next notification or reconnect. A fresh
 * notification (retryAttempt 0) supersedes any pending retry and resets
 * the backoff.
 */
export function scheduleListChangedRefresh(
	host: CapabilityFetcherHost,
	serverName: string,
	kind: "tools" | "resources" | "prompts",
	retryAttempt = 0,
): void {
	const key = `${serverName}:${kind}`
	const existingTimer = host.listChangedRefreshTimers.get(key)
	if (existingTimer) {
		clearTimeout(existingTimer)
	}
	// Supersede any refresh already in flight for this key: its result is
	// older than the change signal that got us here, so publishing it
	// would briefly expose an obsolete list before this refresh corrects it.
	const generation = (host.listChangedRefreshGeneration.get(key) ?? 0) + 1
	host.listChangedRefreshGeneration.set(key, generation)
	const superseded = () => host.listChangedRefreshGeneration.get(key) !== generation
	let delayMs: number
	if (retryAttempt === 0) {
		// Debounce, but cap the total deferral: a sustained stream of
		// notifications re-arming the timer would otherwise starve the
		// refresh indefinitely.
		const now = Date.now()
		const deadline = host.listChangedRefreshDeadlines.get(key) ?? now + LIST_CHANGED_MAX_WAIT_MS
		host.listChangedRefreshDeadlines.set(key, deadline)
		delayMs = Math.max(0, Math.min(LIST_CHANGED_DEBOUNCE_MS, deadline - now))
	} else {
		delayMs = LIST_CHANGED_RETRY_BASE_DELAY_MS * 2 ** (retryAttempt - 1)
	}
	host.listChangedRefreshTimers.set(
		key,
		setTimeout(() => {
			host.listChangedRefreshTimers.delete(key)
			host.listChangedRefreshDeadlines.delete(key)
			// Chain onto any refresh still in flight for this key: two
			// concurrent refreshes could otherwise complete out of order
			// and let a stale response overwrite a newer list.
			const previous = host.listChangedRefreshInFlight.get(key) ?? Promise.resolve()
			const run = previous
				.then(() => refreshChangedList(host, serverName, kind, superseded))
				.then((outcome) => {
					if (outcome === "failed" && retryAttempt < LIST_CHANGED_MAX_RETRIES && !superseded()) {
						scheduleListChangedRefresh(host, serverName, kind, retryAttempt + 1)
					}
				})
				.catch((error) => {
					Logger.error(`[MCP] Failed to refresh ${kind} for ${serverName} after list_changed notification:`, error)
				})
			host.listChangedRefreshInFlight.set(key, run)
			run.finally(() => {
				if (host.listChangedRefreshInFlight.get(key) === run) {
					host.listChangedRefreshInFlight.delete(key)
				}
			})
		}, delayMs),
	)
}

/**
 * Refreshes the given cached list. Returns "failed" when a fetch failed
 * (the caller retries), "skipped" when the refresh was superseded or the
 * connection is gone or was replaced (no retry: a newer refresh or the
 * replacement connection's connect-time fetch covers it), and "refreshed"
 * on success.
 */
export async function refreshChangedList(
	host: CapabilityFetcherHost,
	serverName: string,
	kind: "tools" | "resources" | "prompts",
	superseded: () => boolean,
): Promise<"refreshed" | "failed" | "skipped"> {
	// Look the connection up fresh: it may have been deleted (or replaced
	// by a reconnect) while the debounce timer was pending. A superseded
	// run (a newer notification re-scheduled this key) skips the fetch
	// outright — the newer refresh will fetch fresher data.
	const connection = host.connections.find((conn) => conn.server.name === serverName)
	if (!connection || connection.server.disabled || !connection.client || superseded()) {
		return "skipped"
	}

	// This run is stale once the connection was deleted/replaced (a
	// replacement fetched fresh lists at connect time, after the change
	// that produced this notification) or a newer notification superseded
	// it (that refresh will fetch fresher data). A stale run must neither
	// publish its (older) result nor retry — hence "skipped", including
	// for fetch failures, which staleness explains (e.g. the transport
	// was torn down mid-flight by a reconnect).
	const stale = () => superseded() || host.connections.find((conn) => conn.server.name === serverName) !== connection

	// A failed fetch returns undefined; keep the previous cached list in
	// that case rather than publishing an empty one, and skip the webview
	// notification entirely when nothing was refreshed.
	let tools: McpTool[] | undefined
	let resources: McpResource[] | undefined
	let resourceTemplates: McpResourceTemplate[] | undefined
	let prompts: McpPrompt[] | undefined
	let fetchFailed = false
	switch (kind) {
		case "tools":
			tools = await host.fetchToolsList(serverName)
			if (tools === undefined) {
				return stale() ? "skipped" : "failed"
			}
			break
		case "resources":
			resources = await host.fetchResourcesList(serverName)
			resourceTemplates = await host.fetchResourceTemplatesList(serverName)
			if (resources === undefined && resourceTemplates === undefined) {
				return stale() ? "skipped" : "failed"
			}
			// Half of the pair failed: publish the successful half now and
			// still retry so the other half doesn't stay stale.
			fetchFailed = resources === undefined || resourceTemplates === undefined
			break
		case "prompts":
			prompts = await host.fetchPromptsList(serverName)
			if (prompts === undefined) {
				return stale() ? "skipped" : "failed"
			}
			break
	}

	if (stale()) {
		return "skipped"
	}

	if (tools !== undefined) {
		connection.server.tools = tools
	}
	if (resources !== undefined) {
		connection.server.resources = resources
	}
	if (resourceTemplates !== undefined) {
		connection.server.resourceTemplates = resourceTemplates
	}
	if (prompts !== undefined) {
		connection.server.prompts = prompts
	}

	// Push the refreshed lists to the webview; for tools this also runs
	// the tool-list change check that notifies the SDK controller. A
	// publish failure counts as "failed" so the caller retries: the cache
	// is updated but consumers haven't seen it yet.
	try {
		await host.notifyWebviewOfServerChanges()
	} catch (error) {
		Logger.error(`[MCP] Failed to publish refreshed ${kind} for ${serverName}:`, error)
		return "failed"
	}
	return fetchFailed ? "failed" : "refreshed"
}
