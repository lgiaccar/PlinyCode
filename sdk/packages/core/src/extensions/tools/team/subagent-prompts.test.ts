import { describe, expect, it } from "vitest";
import {
	buildSubAgentSystemPrompt,
	SUB_AGENT_ROLE_RULES,
} from "./subagent-prompts";

describe("buildSubAgentSystemPrompt", () => {
	it("gives a sub-agent the base prompt, its environment and the parent's instructions as rules", () => {
		const prompt = buildSubAgentSystemPrompt("Find every caller of foo.", {
			providerId: "pliny",
			modelId: "m",
			cwd: "/repo",
			clineIdeName: "VS Code",
			clinePlatform: "linux",
			mode: "act",
			currentDate: "10/9/2026",
			gitSnapshot: { branch: "main" },
			promptSuffix:
				"## Repository memory (read-only excerpt)\n- Use bun, not npm",
		});

		expect(prompt).toContain("<env>");
		expect(prompt).toContain("1. Platform: linux");
		expect(prompt).toContain("2. Date: 10/9/2026");
		expect(prompt).toContain("3. IDE: VS Code");
		expect(prompt).toContain("4. Working Directory: /repo");
		expect(prompt).toContain("Current branch: main");
		expect(prompt).toContain(SUB_AGENT_ROLE_RULES);
		expect(prompt).toContain(
			"## Instructions from the parent\nFind every caller of foo.",
		);
		expect(prompt).toContain("- Use bun, not npm");
		expect(prompt).not.toContain("switch_to_act_mode");
		// The role comes before the parent's instructions, which come before the memory.
		expect(prompt.indexOf(SUB_AGENT_ROLE_RULES)).toBeLessThan(
			prompt.indexOf("## Instructions from the parent"),
		);
		expect(prompt.indexOf("## Instructions from the parent")).toBeLessThan(
			prompt.indexOf("read-only excerpt"),
		);
	});

	it("still builds a full prompt when the parent wrote no instructions", () => {
		const prompt = buildSubAgentSystemPrompt("   ", {
			providerId: "pliny",
			modelId: "m",
			cwd: "/repo",
		});
		expect(prompt).toContain("<env>");
		expect(prompt).toContain(SUB_AGENT_ROLE_RULES);
		expect(prompt).not.toContain("## Instructions from the parent");
	});

	it("follows the parent session's mode", () => {
		const base = {
			providerId: "pliny",
			modelId: "m",
			cwd: "/repo",
		};
		const act = buildSubAgentSystemPrompt("x", { ...base, mode: "act" });
		const plan = buildSubAgentSystemPrompt("x", { ...base, mode: "plan" });
		const ask = buildSubAgentSystemPrompt("x", { ...base, mode: "ask" });
		expect(plan).not.toBe(act);
		expect(ask).toBe(plan);
	});

	it("keeps the override shape for the cline provider", () => {
		expect(
			buildSubAgentSystemPrompt("You are focused", {
				providerId: "cline",
				modelId: "m",
			}),
		).toBe("You are focused");
	});
});
