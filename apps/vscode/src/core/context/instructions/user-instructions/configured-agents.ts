import { buildConfiguredAgentToolDescriptors, loadConfiguredAgentConfigs } from "@plinycode/core"
import { resolveAgentConfigSearchPaths, resolveAgentsConfigDirPath } from "@plinycode/shared/storage"
import path from "path"

/**
 * Configured agents are the `.cline/agents/*.md` files of the workspace and
 * the global agents folder (`~/.cline/agents`). The engine turns each into a
 * `subagent_<name>` tool (docs/agent-tools.md). This module lists them for
 * the Agents tab and turns the tab's toggles into tool policies, so a
 * switched-off agent's tool never reaches the model.
 */

type AgentToggles = Record<string, boolean>

export interface AgentToggleSource {
	getGlobalSettingsKey(key: "globalAgentToggles"): AgentToggles | undefined
	getWorkspaceStateKey(key: "localAgentToggles"): AgentToggles | undefined
}

export interface ConfiguredAgentEntry {
	name: string
	description: string
	path: string
	scope: "workspace" | "global"
	enabled: boolean
	/** `providerId/modelId` from the frontmatter; empty when the agent uses the conversation's model. */
	model: string
	/** The tool the model calls; empty for a file that did not load. */
	toolName: string
	/** Why the file did not load. */
	error?: string
}

/** Where the engine reads agents from, workspace first; overridable for tests. */
interface AgentLocations {
	searchPaths: string[]
	globalDir: string
}

export function resolveAgentLocations(workspaceRoot: string | undefined, extraSearchPaths?: string[]): AgentLocations {
	const base = resolveAgentConfigSearchPaths(workspaceRoot)
	const searchPaths = extraSearchPaths && extraSearchPaths.length > 0 ? [...new Set([...base, ...extraSearchPaths])] : base
	return { searchPaths, globalDir: resolveAgentsConfigDirPath() }
}

/** The workspace folder the New agent button writes to. */
export function workspaceAgentsDir(workspaceRoot: string): string {
	return path.join(workspaceRoot, ".cline", "agents")
}

function normalizeAgentPath(filePath: string): string {
	const resolved = path.resolve(filePath)
	// Windows paths are case-insensitive, and VS Code and Node disagree on the drive letter's case.
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function isInside(dir: string, filePath: string): boolean {
	const relative = path.relative(normalizeAgentPath(dir), normalizeAgentPath(filePath))
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
}

/** An agent is on unless one of the toggle maps switched its file off. */
export function isAgentEnabled(filePath: string, toggles: AgentToggleSource): boolean {
	const target = normalizeAgentPath(filePath)
	const maps = [toggles.getGlobalSettingsKey("globalAgentToggles"), toggles.getWorkspaceStateKey("localAgentToggles")]
	return !maps.some((map) =>
		Object.entries(map ?? {}).some(([agentPath, enabled]) => enabled === false && normalizeAgentPath(agentPath) === target),
	)
}

function describeModel(providerId: string | undefined, modelId: string | undefined): string {
	if (providerId && modelId) {
		return `${providerId}/${modelId}`
	}
	return modelId ?? providerId ?? ""
}

/**
 * The agents the engine would load for this workspace, with the tool name it
 * gives each, plus the files it could not load. An agent whose name a
 * workspace agent already took is not loaded, so it is not listed either.
 */
export function listConfiguredAgents(
	workspaceRoot: string | undefined,
	toggles: AgentToggleSource,
	locations: AgentLocations = resolveAgentLocations(workspaceRoot),
): ConfiguredAgentEntry[] {
	const { configs, errors } = loadConfiguredAgentConfigs({ searchPaths: locations.searchPaths })
	const scopeOf = (filePath: string): ConfiguredAgentEntry["scope"] =>
		isInside(locations.globalDir, filePath) ? "global" : "workspace"

	const entries: ConfiguredAgentEntry[] = buildConfiguredAgentToolDescriptors(configs)
		.filter(({ config }) => config.path)
		.map(({ toolName, config }) => {
			const filePath = config.path as string
			return {
				name: config.name,
				description: config.description,
				path: filePath,
				scope: scopeOf(filePath),
				enabled: isAgentEnabled(filePath, toggles),
				model: describeModel(config.providerId, config.modelId),
				toolName,
			}
		})
	for (const failure of errors) {
		// A folder that cannot be read is logged by the engine; only files are listed.
		if (locations.searchPaths.some((dir) => normalizeAgentPath(dir) === normalizeAgentPath(failure.path))) {
			continue
		}
		entries.push({
			name: path.basename(failure.path, path.extname(failure.path)),
			description: "",
			path: failure.path,
			scope: scopeOf(failure.path),
			enabled: isAgentEnabled(failure.path, toggles),
			model: "",
			toolName: "",
			error: failure.error.message,
		})
	}
	return entries.sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Tool policies that take the switched-off agents' tools out of the request.
 * The engine drops a tool whose policy says `enabled: false` before the model
 * sees the tool list (runtime-builder's filterAvailableTools).
 */
function buildDisabledAgentToolPolicies(
	workspaceRoot: string | undefined,
	toggles: AgentToggleSource,
	locations?: AgentLocations,
): Record<string, { enabled: false }> {
	const policies: Record<string, { enabled: false }> = {}
	for (const agent of listConfiguredAgents(workspaceRoot, toggles, locations)) {
		if (!agent.enabled && agent.toolName) {
			policies[agent.toolName] = { enabled: false }
		}
	}
	return policies
}

/**
 * A session's tool policies with the switched-off agents' tools disabled, or
 * `undefined` when no agent is off and the policies stay as they are.
 */
export function withDisabledAgentPolicies<P extends object>(
	toolPolicies: Record<string, P> | undefined,
	workspaceRoot: string | undefined,
	toggles: AgentToggleSource,
	locations?: AgentLocations,
): Record<string, P | { enabled: false }> | undefined {
	const disabled = buildDisabledAgentToolPolicies(workspaceRoot, toggles, locations)
	if (Object.keys(disabled).length === 0) {
		return undefined
	}
	return { ...toolPolicies, ...disabled }
}
