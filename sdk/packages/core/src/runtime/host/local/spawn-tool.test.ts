import type { AgentEvent, AgentTool } from "@plinycode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreSessionConfig } from "../../../types/config";
import {
	createSessionSpawnTool,
	DEFAULT_SUB_AGENT_MAX_ITERATIONS,
	MAX_SUB_AGENT_DEPTH,
} from "./spawn-tool";

const runMock = vi.fn();
const agentConstructorSpy = vi.fn();
const subAgentListeners: Array<(event: AgentEvent) => void> = [];

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
		subscribeEvents(listener: (event: AgentEvent) => void): () => void {
			subAgentListeners.push(listener);
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
	onAgentEvent: vi.fn(),
	invokeBackendOptional: async () => {},
	settleSubAgentUsage: vi.fn(),
};

function emitSubAgentEvent(event: AgentEvent): void {
	for (const listener of subAgentListeners) {
		listener(event);
	}
}

const usageEvent = {
	type: "usage",
	inputTokens: 30,
	outputTokens: 6,
	cacheReadTokens: 4,
	cost: 0.05,
	totalInputTokens: 30,
	totalOutputTokens: 6,
} as AgentEvent;

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
		subAgentListeners.length = 0;
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

	it("tags the sub-agent's events with its id and settles its usage from the result", async () => {
		runMock.mockImplementation(async () => {
			emitSubAgentEvent(usageEvent);
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: {
					inputTokens: 30,
					outputTokens: 6,
					cacheReadTokens: 4,
					totalCost: 0.05,
				},
			};
		});
		const spawn = createSessionSpawnTool(deps, config, "root-session");
		await spawn.execute({ task: "look around" }, context);

		// Without the ids the host counted the sub-agent's usage as the root's.
		expect(deps.onAgentEvent).toHaveBeenCalledWith(
			"root-session",
			config,
			expect.objectContaining({
				type: "usage",
				agentId: "sub-agent-1",
				parentAgentId: "root",
			}),
		);
		expect(deps.settleSubAgentUsage).toHaveBeenCalledTimes(1);
		expect(deps.settleSubAgentUsage).toHaveBeenCalledWith(
			"root-session",
			"sub-agent-1",
			expect.objectContaining({
				inputTokens: 30,
				outputTokens: 6,
				cacheReadTokens: 4,
				totalCost: 0.05,
			}),
		);
	});

	it("settles a failed sub-agent's usage from its progress", async () => {
		runMock.mockImplementation(async () => {
			emitSubAgentEvent(usageEvent);
			throw new Error("model failed");
		});
		const spawn = createSessionSpawnTool(deps, config, "root-session");
		await expect(
			spawn.execute({ task: "look around" }, context),
		).rejects.toThrow("model failed");

		expect(deps.settleSubAgentUsage).toHaveBeenCalledWith(
			"root-session",
			"sub-agent-1",
			{
				inputTokens: 30,
				outputTokens: 6,
				cacheReadTokens: 4,
				cacheWriteTokens: 0,
				totalCost: 0.05,
			},
		);
	});
});
