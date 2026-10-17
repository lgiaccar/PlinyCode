import type {
	AgentConfig,
	AgentEvent,
	AgentTool,
	ToolApprovalRequest,
	ToolApprovalResult,
	ToolPolicy,
} from "@plinycode/shared";
import {
	createBuiltinTools,
	resolveToolPresetName,
	type ToolExecutors,
	ToolPresets,
} from "../../../extensions/tools";
import type {
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../../extensions/tools/team";
import { createSpawnAgentTool } from "../../../extensions/tools/team";
import { resolveSubAgentLimits } from "../../../extensions/tools/team/sub-agent-limits";
import { filterDisabledTools } from "../../../services/global-settings";
import type { CoreSessionConfig } from "../../../types/config";
import type { ActiveSession } from "../../../types/session";

export interface SpawnToolDeps {
	getSession(sessionId: string): ActiveSession | undefined;
	onAgentEvent(
		rootSessionId: string,
		config: CoreSessionConfig,
		event: AgentEvent,
	): void;
	invokeBackendOptional(method: string, ...args: unknown[]): Promise<void>;
}

export interface SessionSubAgentLifecycleCallbacks {
	onSubAgentEvent: (event: AgentEvent) => void;
	onSubAgentStart: (context: SubAgentStartContext) => void;
	onSubAgentEnd: (context: SubAgentEndContext) => void;
}

export interface SessionSpawnToolOptions {
	/** Depth of the agent that owns this tool; its sub-agents are one deeper. */
	depth?: number;
	/**
	 * Host tools a sub-agent gets besides the built-ins, e.g. the host's own
	 * shell. Tools whose name a built-in already has are left out.
	 */
	extraTools?: AgentTool[];
	/** Per-tool policy for the sub-agents' calls, normally the session's. */
	toolPolicies?: Record<string, ToolPolicy>;
	/** Approval callback for the sub-agents' calls, normally the session's. */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/** Context compaction for sub-agent runs, read when a run starts. */
	getPrepareTurn?: () => AgentConfig["prepareTurn"];
}

export function createSessionSubAgentLifecycleCallbacks(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
): SessionSubAgentLifecycleCallbacks {
	return {
		onSubAgentEvent: (event) => deps.onAgentEvent(rootSessionId, config, event),
		onSubAgentStart: (context) => {
			void deps.invokeBackendOptional(
				"handleSubAgentStart",
				rootSessionId,
				context,
			);
		},
		onSubAgentEnd: (context) => {
			void deps.invokeBackendOptional(
				"handleSubAgentEnd",
				rootSessionId,
				context,
			);
		},
	};
}

export function createSessionSpawnTool(
	deps: SpawnToolDeps,
	config: CoreSessionConfig,
	rootSessionId: string,
	toolExecutors?: Partial<ToolExecutors>,
	options: SessionSpawnToolOptions = {},
): AgentTool {
	const lifecycle = createSessionSubAgentLifecycleCallbacks(
		deps,
		config,
		rootSessionId,
	);
	const depth = options.depth ?? 0;
	const limits = resolveSubAgentLimits(config.subAgentLimits);
	// The root is at depth 0. This tool's sub-agents run at depth + 1 and get
	// a spawn tool of their own only while that leaves them above the limit.
	const subAgentsCanDelegate =
		config.enableSpawnAgent === true && depth + 1 < limits.maxDepth;
	const createSubAgentTools = () => {
		const tools: AgentTool[] = config.enableTools
			? createBuiltinTools({
					cwd: config.cwd,
					...ToolPresets[resolveToolPresetName({ mode: config.mode })],
					executors: toolExecutors,
				})
			: [];
		const taken = new Set(tools.map((tool) => tool.name));
		for (const tool of options.extraTools ?? []) {
			if (!taken.has(tool.name)) {
				tools.push(tool);
				taken.add(tool.name);
			}
		}
		if (subAgentsCanDelegate) {
			tools.push(
				createSessionSpawnTool(deps, config, rootSessionId, toolExecutors, {
					...options,
					depth: depth + 1,
				}),
			);
		}
		return filterDisabledTools(tools);
	};

	return createSpawnAgentTool({
		configProvider: {
			getRuntimeConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getRuntimeConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					cwd: config.cwd,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
					maxIterations: config.maxIterations,
					hooks: config.hooks,
					extensions: config.extensions,
					logger: config.logger,
				},
			getConnectionConfig: () =>
				deps
					.getSession(rootSessionId)
					?.runtime.delegatedAgentConfigProvider?.getConnectionConfig() ?? {
					providerId: config.providerId,
					modelId: config.modelId,
					apiKey: config.apiKey,
					baseUrl: config.baseUrl,
					headers: config.headers,
					agentModelFactory: config.agentModelFactory,
					onRunError: config.onRunError,
					providerConfig: config.providerConfig,
					knownModels: config.knownModels,
					thinking: config.thinking,
				},
			updateConnectionDefaults: () => {},
		},
		defaultMaxIterations: limits.maxIterations,
		maxConcurrent: limits.maxConcurrent,
		subAgentsCanDelegate,
		createSubAgentTools,
		toolPolicies: options.toolPolicies,
		requestToolApproval: options.requestToolApproval,
		getPrepareTurn: options.getPrepareTurn,
		...lifecycle,
	}) as AgentTool;
}
