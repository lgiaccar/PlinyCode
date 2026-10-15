import type { AgentTool } from "@plinycode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig } from "../../../types/config";
import {
	createSessionSpawnTool,
	DEFAULT_SUB_AGENT_MAX_ITERATIONS,
	MAX_SUB_AGENT_DEPTH,
} from "./spawn-tool";

const runMock = vi.fn();
const agentConstructorSpy = vi.fn();

vi.mock("../../orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class MockSessionRuntime {
		constructor(config: unknown) {
			agentConstructorSpy(config);
		}
		getAgentId(): string {
			return "sub-agent-1";
		}
		getConversationId(): string {
			return "conv-sub-1";
		}
		subscribeEvents(): () => void {
			return () => {};
		}
		async run(input: string): Promise<unknown> {
			return runMock(input);
		}
	},
}));

function tool(name: string): AgentTool {
	return {
		name,
		description: name,
		inputSchema: { type: "object" },
		execute: async () => `${name} ran`,
	};
}

const deps = {
	getSession: () => undefined,
	onAgentEvent: () => {},
	invokeBackendOptional: async () => {},
};

const config = {
	providerId: "pliny",
	modelId: "m",
	cwd: "/repo",
	systemPrompt: "",
	enableTools: true,
	enableSpawnAgent: true,
	mode: "act",
} as unknown as CoreSessionConfig;

const context = { agentId: "root", iteration: 1 };

describe("createSessionSpawnTool", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		runMock.mockResolvedValue({
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
	});

	it("gives a sub-agent the host's extra tools next to the built-ins, without duplicates or a nested spawn_agent", async () => {
		expect(MAX_SUB_AGENT_DEPTH).toBe(1);
		const spawn = createSessionSpawnTool(
			deps,
			config,
			"root-session",
			undefined,
			{
				extraTools: [tool("run_commands"), tool("wait"), tool("read_files")],
			},
		);
		await spawn.execute({ task: "look around" }, context);

		const agentConfig = agentConstructorSpy.mock.calls[0][0] as {
			tools: AgentTool[];
			maxIterations?: number;
		};
		const names = agentConfig.tools.map((t) => t.name);
		expect(names).toContain("run_commands");
		expect(names).toContain("wait");
		expect(names.filter((name) => name === "read_files")).toHaveLength(1);
		expect(names).not.toContain("spawn_agent");
		// The built-in read_files wins over the host's same-named tool.
		const readFiles = agentConfig.tools.find((t) => t.name === "read_files");
		expect(readFiles?.description).not.toBe("read_files");
		expect(agentConfig.maxIterations).toBe(DEFAULT_SUB_AGENT_MAX_ITERATIONS);
	});

	it("threads the session's policies, approval and compaction into the sub-agent run", async () => {
		const toolPolicies = { editor: { autoApprove: false } };
		const requestToolApproval = vi.fn(async () => ({ approved: true }));
		const prepareTurn = vi.fn(async () => undefined);
		const spawn = createSessionSpawnTool(
			deps,
			{ ...config, subAgentMaxIterations: 7 },
			"root-session",
			undefined,
			{
				toolPolicies,
				requestToolApproval,
				getPrepareTurn: () => prepareTurn,
			},
		);
		await spawn.execute(
			{ task: "edit something", instructions: "Be careful" },
			context,
		);

		expect(agentConstructorSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				toolPolicies,
				requestToolApproval,
				prepareTurn,
				maxIterations: 7,
				parentAgentId: "root",
			}),
		);
		const agentConfig = agentConstructorSpy.mock.calls[0][0] as {
			systemPrompt: string;
		};
		expect(agentConfig.systemPrompt).toContain("Be careful");
		expect(agentConfig.systemPrompt).toContain("<env>");
	});
});
