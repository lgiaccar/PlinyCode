import type {
	AgentConfig,
	AgentEvent,
	AgentHooks,
	AgentResult,
	AgentTool,
	BasicLogger,
	ModelTool,
	RuntimeConfigExtensionKind,
	ToolApprovalRequest,
	ToolApprovalResult,
} from "@plinycode/shared";
import type {
	AgentPluginPackageMcpServer,
	AgentPluginPackageSkill,
} from "../../extensions/agent-plugin";
import type { UserInstructionConfigService } from "../../extensions/config";
import type {
	RunCommandExecutionController,
	ToolExecutors,
} from "../../extensions/tools";
import type {
	DelegatedAgentConfigProvider,
	SubAgentEndContext,
	SubAgentStartContext,
} from "../../extensions/tools/team";
import type { WorkspaceManager } from "../../services/workspace/workspace-manager";
import type { CoreSessionConfig } from "../../types/config";
import type { RuleFileFilter } from "../safety/rules";

export interface BuiltRuntime {
	tools: AgentTool[];
	modelTools?: ModelTool[];
	hooks?: AgentHooks;
	logger?: BasicLogger;
	delegatedAgentConfigProvider?: DelegatedAgentConfigProvider;
	extensions?: AgentConfig["extensions"];
	completionPolicy?: AgentConfig["completionPolicy"];
	shutdown: (reason: string) => Promise<void> | void;
}

export interface RuntimeBuilderInput {
	config: CoreSessionConfig;
	/**
	 * Host-resolved stable end-user identity, forwarded so delegated
	 * sub-agents send the same gateway `userId` as the lead.
	 */
	distinctId?: string;
	hooks?: AgentHooks;
	extensions?: AgentConfig["extensions"];
	onSubAgentEvent?: (event: AgentEvent) => void;
	onSubAgentStart?: (context: SubAgentStartContext) => void | Promise<void>;
	onSubAgentEnd?: (context: SubAgentEndContext) => void | Promise<void>;
	createSpawnTool?: () => AgentTool;
	userInstructionService?: UserInstructionConfigService;
	/** Host predicate that drops rules loaded from disabled files. */
	ruleFilter?: RuleFileFilter;
	pluginSkillDirectories?: ReadonlyArray<string>;
	agentPluginSkills?: ReadonlyArray<AgentPluginPackageSkill>;
	agentPluginMcpServers?: ReadonlyArray<AgentPluginPackageMcpServer>;
	configExtensions?: RuntimeConfigExtensionKind[];
	toolExecutors?: Partial<ToolExecutors>;
	runCommandExecutionController?: RunCommandExecutionController;
	toolPolicies?: CoreSessionConfig["toolPolicies"];
	workspaceManager?: WorkspaceManager;
	logger?: BasicLogger;
	requestToolApproval?: (
		request: ToolApprovalRequest,
	) => Promise<ToolApprovalResult> | ToolApprovalResult;
	/**
	 * Context compaction for delegated runs (configured agents), read when a
	 * run starts: the host builds it after the runtime.
	 */
	subAgentPrepareTurn?: () => AgentConfig["prepareTurn"];
}

export interface RuntimeBuilder {
	build(input: RuntimeBuilderInput): Promise<BuiltRuntime> | BuiltRuntime;
}

export interface SessionRuntime {
	start(config: CoreSessionConfig): Promise<{ sessionId: string }>;
	send(sessionId: string, prompt: string): Promise<AgentResult | undefined>;
	abort(sessionId: string, reason?: unknown): Promise<void>;
	stop(sessionId: string): Promise<void>;
	poll(): Promise<string[]>;
}
