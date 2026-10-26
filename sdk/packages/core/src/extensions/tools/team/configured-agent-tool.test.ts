import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfiguredAgentConfigs } from "./configured-agent-config";
import { buildConfiguredAgentToolName } from "./configured-agent-names";
import { createConfiguredAgentTools } from "./configured-agent-tool";
import { DEFAULT_SUB_AGENT_TIMEOUT_MS } from "./spawn-agent-tool";

const agentConstructorSpy = vi.hoisted(() => vi.fn());
vi.mock("../../../runtime/orchestration/session-runtime-orchestrator", () => ({
	SessionRuntime: class {
		constructor(config: unknown) {
			agentConstructorSpy(config);
		}
		getAgentId() {
			return "configured-1";
		}
		getConversationId() {
			return "configured-conversation";
		}
		subscribeEvents() {
			return () => {};
		}
		async run() {
			return {
				text: "done",
				iterations: 1,
				finishReason: "completed",
				usage: { inputTokens: 1, outputTokens: 1 },
			};
		}
	},
}));

const configProvider = {
	getRuntimeConfig: () => ({
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "key",
	}),
	getConnectionConfig: () => ({
		providerId: "anthropic",
		modelId: "claude-sonnet-4-6",
		apiKey: "key",
	}),
	updateConnectionDefaults: () => {},
};

describe("configured agent tools", () => {
	beforeEach(() => {
		agentConstructorSpy.mockClear();
	});

	it("builds stable subagent tool names", () => {
		expect(buildConfiguredAgentToolName("Code Reviewer")).toBe(
			"subagent_code_reviewer",
		);
		expect(buildConfiguredAgentToolName("___")).toBe("subagent_agent");
	});

	it("matches spawn_agent timeout and retry policy", () => {
		const [tool] = createConfiguredAgentTools({
			configProvider,
			agents: [
				{
					name: "code-reviewer",
					description: "Reviews code",
					systemPrompt: "You are a code reviewer.",
				},
			],
		});

		expect(tool?.name).toBe("subagent_code_reviewer");
		expect(tool?.executionMode).toBe("parallel");
		expect(tool?.timeoutMs).toBe(DEFAULT_SUB_AGENT_TIMEOUT_MS);
		expect(tool?.retryable).toBe(false);
	});

	it("gives an agent without maxIterations the sub-agent default, and keeps its own otherwise", async () => {
		const [plain, capped] = createConfiguredAgentTools({
			configProvider,
			defaultMaxIterations: 12,
			agents: [
				{ name: "a-plain", description: "d", systemPrompt: "p" },
				{
					name: "b-capped",
					description: "d",
					systemPrompt: "p",
					maxIterations: 5,
				},
			],
		});
		const context = { agentId: "root", iteration: 1 } as never;
		await plain?.execute({ prompt: "go" }, context);
		await capped?.execute({ prompt: "go" }, context);
		expect(agentConstructorSpy.mock.calls[0][0]).toMatchObject({
			maxIterations: 12,
		});
		expect(agentConstructorSpy.mock.calls[1][0]).toMatchObject({
			maxIterations: 5,
		});
	});
});

describe("loadConfiguredAgentConfigs", () => {
	it("loads .md agent files next to .yml ones", () => {
		const dir = mkdtempSync(join(tmpdir(), "configured-agents-"));
		try {
			const agentsDir = join(dir, "agents");
			mkdirSync(agentsDir);
			const body = (name: string) =>
				`---\nname: ${name}\ndescription: Does ${name}\n---\nYou are ${name}.\n`;
			writeFileSync(join(agentsDir, "reviewer.md"), body("reviewer"));
			writeFileSync(join(agentsDir, "tester.yml"), body("tester"));
			writeFileSync(join(agentsDir, "notes.txt"), body("ignored"));
			const { configs, errors } = loadConfiguredAgentConfigs({
				searchPaths: [agentsDir],
			});
			expect(errors).toEqual([]);
			expect(configs.map((config) => config.name)).toEqual([
				"reviewer",
				"tester",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads agent files from immediate subdirectories", () => {
		const dir = mkdtempSync(join(tmpdir(), "configured-agents-"));
		try {
			const agentsDir = join(dir, "agents");
			const subDir = join(agentsDir, "fm-agents");
			mkdirSync(subDir, { recursive: true });
			const body = (name: string) =>
				`---\nname: ${name}\ndescription: Does ${name}\n---\nYou are ${name}.\n`;
			writeFileSync(join(subDir, "coder.md"), body("coder"));
			writeFileSync(join(subDir, "planner.md"), body("planner"));
			const { configs, errors } = loadConfiguredAgentConfigs({
				searchPaths: [agentsDir],
			});
			expect(errors).toEqual([]);
			expect(configs.map((config) => config.name).sort()).toEqual([
				"coder",
				"planner",
			]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
