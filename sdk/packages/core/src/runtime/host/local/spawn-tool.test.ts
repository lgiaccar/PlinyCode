import type { AgentEvent, AgentTool } from "@plinycode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	DEFAULT_MAX_CONCURRENT_SUB_AGENTS,
	DEFAULT_SUB_AGENT_MAX_DEPTH,
	DEFAULT_SUB_AGENT_MAX_ITERATIONS,
	resolveSubAgentLimits,
} from "../../../extensions/tools/team/sub-agent-limits";
import type { CoreSessionConfig } from "../../../types/config";
import { createSessionSpawnTool } from "./spawn-tool";

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
		expect(DEFAULT_SUB_AGENT_MAX_DEPTH).toBe(1);
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
			{ ...config, subAgentLimits: { maxIterations: 7 } },
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

type CapturedAgentConfig = {
	tools: AgentTool[];
	maxIterations?: number;
	onEvent?: (event: AgentEvent) => void;
};

function capturedConfig(call: number): CapturedAgentConfig {
	return agentConstructorSpy.mock.calls[call][0] as CapturedAgentConfig;
}

function toolNames(call: number): string[] {
	return capturedConfig(call).tools.map((t) => t.name);
}

describe("sub-agent limits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		runMock.mockResolvedValue({
			text: "done",
			iterations: 1,
			finishReason: "completed",
			usage: { inputTokens: 1, outputTokens: 1 },
		});
	});

	it("resolves to the old constants when the host sets nothing", () => {
		expect(resolveSubAgentLimits(undefined)).toEqual({
			maxDepth: 1,
			maxConcurrent: 3,
			maxIterations: 40,
		});
		expect(DEFAULT_MAX_CONCURRENT_SUB_AGENTS).toBe(3);
		expect(DEFAULT_SUB_AGENT_MAX_ITERATIONS).toBe(40);
		// Invalid values fall back; depth never goes past the ceiling.
		expect(
			resolveSubAgentLimits({
				maxDepth: 0,
				maxConcurrent: -2,
				maxIterations: Number.NaN,
			}),
		).toEqual({ maxDepth: 1, maxConcurrent: 3, maxIterations: 40 });
		expect(resolveSubAgentLimits({ maxDepth: 9 }).maxDepth).toBe(2);
	});

	it("with depth 2 gives the first level spawn_agent and the second none", async () => {
		const spawn = createSessionSpawnTool(
			deps,
			{
				...config,
				subAgentLimits: { maxDepth: 2 },
			} as CoreSessionConfig,
			"root-session",
		);
		expect(spawn.description).toContain("may delegate once more");

		await spawn.execute({ task: "level one" }, context);
		expect(toolNames(0)).toContain("spawn_agent");

		const nested = capturedConfig(0).tools.find(
			(t) => t.name === "spawn_agent",
		) as AgentTool;
		expect(nested.description).toContain(
			"cannot ask the user, save memories or delegate further",
		);
		await nested.execute({ task: "level two" }, {
			agentId: "sub-agent-1",
			iteration: 1,
		} as never);
		expect(toolNames(1)).not.toContain("spawn_agent");
	});

	it("caps a host's depth above the ceiling at one nested level", async () => {
		const spawn = createSessionSpawnTool(
			deps,
			{
				...config,
				subAgentLimits: { maxDepth: 5 },
			} as CoreSessionConfig,
			"root-session",
		);
		await spawn.execute({ task: "level one" }, context);
		const nested = capturedConfig(0).tools.find(
			(t) => t.name === "spawn_agent",
		) as AgentTool;
		await nested.execute({ task: "level two" }, {
			agentId: "sub-agent-1",
			iteration: 1,
		} as never);
		expect(toolNames(1)).not.toContain("spawn_agent");
	});

	it("keeps spawn_agent away from sub-agents when spawning is off, whatever the depth", async () => {
		const spawn = createSessionSpawnTool(
			deps,
			{
				...config,
				enableSpawnAgent: false,
				subAgentLimits: { maxDepth: 2 },
			} as CoreSessionConfig,
			"root-session",
		);
		await spawn.execute({ task: "look" }, context);
		expect(toolNames(0)).not.toContain("spawn_agent");
	});

	it("runs at most maxConcurrent sub-agents at once", async () => {
		let active = 0;
		let peak = 0;
		const releases: Array<() => void> = [];
		runMock.mockImplementation(async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise<void>((resolve) => releases.push(resolve));
			active--;
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		});
		const spawn = createSessionSpawnTool(
			deps,
			{
				...config,
				subAgentLimits: { maxConcurrent: 2 },
			} as CoreSessionConfig,
			"root-session",
		);
		const runs = [1, 2, 3, 4].map((n) =>
			spawn.execute({ task: `task ${n}` }, context),
		);
		const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
		await settle();
		expect(active).toBe(2);
		while (releases.length > 0 || active > 0) {
			releases.shift()?.();
			await settle();
		}
		await Promise.all(runs);
		expect(peak).toBe(2);
		expect(runMock).toHaveBeenCalledTimes(4);
	});

	it("adds what a sub-agent's own sub-agents used to its result", async () => {
		runMock.mockImplementationOnce(async () => {
			const { onEvent } = capturedConfig(0);
			onEvent?.({
				type: "content_end",
				contentType: "tool",
				toolName: "spawn_agent",
				toolCallId: "nested-1",
				output: {
					text: "nested report",
					usage: {
						inputTokens: 100,
						outputTokens: 10,
						cacheReadTokens: 50,
						totalCost: 0.5,
					},
				},
			} as AgentEvent);
			return {
				text: "done",
				iterations: 2,
				finishReason: "completed",
				usage: { inputTokens: 20, outputTokens: 2, totalCost: 0.25 },
			};
		});
		const spawn = createSessionSpawnTool(
			deps,
			{
				...config,
				subAgentLimits: { maxDepth: 2 },
			} as CoreSessionConfig,
			"root-session",
		);
		const output = (await spawn.execute({ task: "delegate" }, context)) as {
			usage: Record<string, number>;
		};
		expect(output.usage).toEqual({
			inputTokens: 120,
			outputTokens: 12,
			cacheReadTokens: 50,
			totalCost: 0.75,
		});
	});
});
