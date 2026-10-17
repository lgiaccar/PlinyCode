import {
	type AgentConfig,
	type AgentEvent,
	type AgentResult,
	type AgentTool,
	type AgentToolContext,
	createTool,
	type HookErrorMode,
	type ToolApprovalRequest,
	type ToolApprovalResult,
	type ToolPolicy,
	zodToJsonSchema,
} from "@plinycode/shared";
import { z } from "zod";
import type { ConfiguredAgentConfig } from "./configured-agent-config";
import { buildConfiguredAgentToolDescriptors } from "./configured-agent-names";
import {
	createDelegatedAgent,
	createDelegatedAgentConfigProvider,
	type DelegatedAgentConfigProvider,
	type DelegatedAgentRuntimeConfig,
} from "./delegated-agent";
import {
	createSubAgentProgressReporter,
	DEFAULT_SUB_AGENT_TIMEOUT_MS,
	type SpawnAgentOutput,
	type SubAgentEndContext,
	type SubAgentStartContext,
	spawnAgentOutputFromResult,
	spawnAgentUsageFromProgress,
} from "./spawn-agent-tool";

const ConfiguredAgentInputSchema = z.object({
	prompt: z.string().trim().min(1).describe("Task for the subagent to perform"),
});

export type ConfiguredAgentInput = z.infer<typeof ConfiguredAgentInputSchema>;

export interface ConfiguredAgentToolConfig {
	configProvider: DelegatedAgentConfigProvider;
	agents: ConfiguredAgentConfig[];
	createSubAgentTools?: (
		agent: ConfiguredAgentConfig,
		input: ConfiguredAgentInput,
		context: AgentToolContext,
	) => AgentTool[] | Promise<AgentTool[]>;
	onSubAgentEvent?: (event: AgentEvent) => void;
	hookErrorMode?: HookErrorMode;
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	/** Per-tool policy for the configured agents' own tool calls. */
	toolPolicies?: Record<string, ToolPolicy>;
	/** Approval callback for the configured agents' tool calls. */
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/** The request projection (context compaction) a run uses; read when it starts. */
	getPrepareTurn?: () => AgentConfig["prepareTurn"];
	/** Iterations a run gets when the agent's file sets no `maxIterations`. */
	defaultMaxIterations?: number;
}

function buildAgentRuntimeConfig(
	base: DelegatedAgentRuntimeConfig,
	agent: ConfiguredAgentConfig,
): DelegatedAgentRuntimeConfig {
	return {
		...base,
		providerId: agent.providerId ?? base.providerId,
		modelId: agent.modelId ?? base.modelId,
		maxIterations: agent.maxIterations ?? base.maxIterations,
	};
}

export function createConfiguredAgentTools(
	options: ConfiguredAgentToolConfig,
): AgentTool[] {
	return buildConfiguredAgentToolDescriptors(options.agents).map(
		({ toolName, config }) => {
			const tool = createTool<ConfiguredAgentInput, SpawnAgentOutput>({
				name: toolName,
				executionMode: "parallel",
				description: `Use the "${config.name}" subagent: ${config.description}`,
				inputSchema: zodToJsonSchema(ConfiguredAgentInputSchema),
				execute: async (input, context) => {
					const baseRuntimeConfig = options.configProvider.getRuntimeConfig();
					const configProvider = createDelegatedAgentConfigProvider(
						buildAgentRuntimeConfig(baseRuntimeConfig, config),
					);
					const tools = options.createSubAgentTools
						? await options.createSubAgentTools(config, input, context)
						: [];
					const reporter = createSubAgentProgressReporter(
						context,
						options.onSubAgentEvent,
					);
					// The agent's tool calls follow the host's policies and approval
					// like the parent's: a configured agent edits the same files.
					const subAgent = createDelegatedAgent({
						prompt: config.systemPrompt,
						configProvider,
						tools,
						maxIterations: config.maxIterations ?? options.defaultMaxIterations,
						parentAgentId: context.agentId,
						abortSignal: context.signal,
						onEvent: reporter.onEvent,
						hookErrorMode: options.hookErrorMode,
						toolPolicies: options.toolPolicies,
						requestToolApproval: options.requestToolApproval,
						prepareTurn: options.getPrepareTurn?.(),
					});
					const subAgentId = subAgent.getAgentId();
					const conversationId = subAgent.getConversationId();
					const parentAgentId = context.agentId;
					reporter.bind(subAgentId);
					const spawnInput = {
						systemPrompt: config.systemPrompt,
						task: input.prompt,
					};

					if (options.onSubAgentStart) {
						try {
							await options.onSubAgentStart({
								subAgentId,
								conversationId,
								parentAgentId,
								input: spawnInput,
							});
						} catch {
							// Best-effort observer callback.
						}
					}

					try {
						const result: AgentResult = await subAgent.run(input.prompt);
						const output: SpawnAgentOutput = spawnAgentOutputFromResult(
							result,
							reporter.progress(),
						);
						if (options.onSubAgentEnd) {
							try {
								await options.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input: spawnInput,
									result: output,
									agentResult: result,
									usage: output.usage,
								});
							} catch {
								// Best-effort observer callback.
							}
						}
						return output;
					} catch (error) {
						if (options.onSubAgentEnd) {
							try {
								await options.onSubAgentEnd({
									subAgentId,
									conversationId,
									parentAgentId,
									input: spawnInput,
									error:
										error instanceof Error ? error : new Error(String(error)),
									usage: spawnAgentUsageFromProgress(reporter.progress()),
								});
							} catch {
								// Best-effort observer callback.
							}
						}
						throw error;
					}
				},
				timeoutMs: DEFAULT_SUB_AGENT_TIMEOUT_MS,
				retryable: false,
			});
			return tool as unknown as AgentTool;
		},
	);
}
