import { describe, expect, it } from "vitest";
import {
	ASK_MODE_INSTRUCTIONS,
	buildClineSystemPrompt,
	MODE_TAG_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS,
	PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH,
	processWorkspaceInfo,
} from "./cline";

const BASE_OPTIONS = {
	ide: "VS Code",
	workspaceRoot: "/workspace/project",
	workspaceName: "project",
	platform: "linux",
};

describe("processWorkspaceInfo", () => {
	it("redacts URL credentials while preserving SCP-style SSH remotes", () => {
		const metadata = JSON.parse(
			processWorkspaceInfo({
				rootPath: "/workspace/project",
				associatedRemoteUrls: [
					"origin: https://user:token@github.com/cline/cline.git",
					"backup: ssh://git:secret@example.com/cline/cline.git",
					"mirror: git@github.com:cline/cline.git",
				],
			}),
		);

		expect(
			metadata.workspaces["/workspace/project"].associatedRemoteUrls,
		).toEqual([
			"origin: https://github.com/cline/cline.git",
			"backup: ssh://example.com/cline/cline.git",
			"mirror: git@github.com:cline/cline.git",
		]);
	});
});

describe("buildClineSystemPrompt mode instructions", () => {
	it("explains the user_input mode attribute in act mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "act" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain('<user_input mode="...">');
		expect(prompt).toContain("<mode_notice>");
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS);
	});

	it("appends the plan-mode contract only in plan mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "plan" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS);
		// The mode-tag explanation precedes the plan contract, matching the
		// order the CLI historically composed by hand.
		expect(prompt.indexOf(MODE_TAG_INSTRUCTIONS)).toBeLessThan(
			prompt.indexOf(PLAN_MODE_INSTRUCTIONS),
		);
	});

	it("appends the ask-mode contract only in ask mode", () => {
		const prompt = buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "ask" });
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
		expect(prompt).toContain(ASK_MODE_INSTRUCTIONS);
		expect(prompt).not.toContain(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH);
		expect(ASK_MODE_INSTRUCTIONS).toContain("toggle to Agent mode");
		// Ask mode cannot switch modes itself, on any host.
		expect(ASK_MODE_INSTRUCTIONS).not.toContain("switch_to_act_mode");

		for (const mode of ["act", "plan"] as const) {
			expect(buildClineSystemPrompt({ ...BASE_OPTIONS, mode })).not.toContain(
				ASK_MODE_INSTRUCTIONS,
			);
		}
	});

	it("keeps run_commands available-but-read-only in the plan contract", () => {
		// Explicit product decision: run_commands is NOT removed in plan mode
		// (it is essential for read-only investigation); the mitigation for
		// plan-mode mutations is prompting, so the contract must spell out the
		// inspection-only usage.
		expect(PLAN_MODE_INSTRUCTIONS).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("read-only");
		expect(PLAN_MODE_INSTRUCTIONS).toContain("switch_to_act_mode");
	});

	it("swaps in the manual-switch plan contract when the host has no switch tool", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			planModeSwitchTool: false,
		});
		expect(prompt).toContain(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH);
		expect(prompt).not.toContain("switch_to_act_mode");
		// The read-only run_commands contract is shared by both variants.
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("run_commands");
		expect(PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH).toContain("toggle to Agent mode");
	});

	it("asks the manual-switch host for a plan another model can execute", () => {
		// The Execute plan button can hand the plan files to a cheaper model
		// than the one that wrote them, so the plan has to stand on its own.
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			planModeSwitchTool: false,
		});
		expect(prompt).toContain(
			"an executor that has not seen this conversation and may be a weaker model",
		);
		for (const requirement of [
			"exact file paths",
			"the steps in order",
			"the command that verifies each step",
			"the decisions already made with their reasons",
			"would otherwise have to rediscover",
		]) {
			expect(prompt).toContain(requirement);
		}
		// One short paragraph: the plan contract is sent with every plan-mode call.
		const handoff = PLAN_MODE_INSTRUCTIONS_MANUAL_SWITCH.split("\n\n").find(
			(paragraph) => paragraph.includes("has not seen this conversation"),
		);
		expect(handoff?.length).toBeLessThan(400);
	});

	it("emits mode instructions for both mode: undefined and yolo", () => {
		// After a switch the transcript still contains messages tagged with the
		// other mode, so the explanation is unconditional.
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
		expect(buildClineSystemPrompt({ ...BASE_OPTIONS, mode: "yolo" })).toContain(
			MODE_TAG_INSTRUCTIONS,
		);
	});

	it("places caller rules before the mode instructions", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nAlways speak like a pirate.",
		});
		const rulesIndex = prompt.indexOf("Always speak like a pirate.");
		expect(rulesIndex).toBeGreaterThan(-1);
		expect(rulesIndex).toBeLessThan(prompt.indexOf(MODE_TAG_INSTRUCTIONS));
	});

	it("includes rich workspace metadata for the Cline backend parser", () => {
		const metadata = JSON.stringify({
			workspaces: {
				"/workspace/project": {
					hint: "project",
					associatedRemoteUrls: ["origin: https://github.com/cline/cline.git"],
					latestGitCommitHash: "abc123",
				},
			},
		});
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			providerId: "cline",
			metadata,
		});

		expect(prompt).toContain(`# Workspace Configuration\n${metadata}`);
	});

	it("respects an explicit override prompt without injecting mode sections", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			overridePrompt: "You are a custom agent.",
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});

function envBlock(prompt: string): string {
	const start = prompt.indexOf("<env>");
	const end = prompt.indexOf("</env>");
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return prompt.slice(start, end + "</env>".length);
}

describe("buildClineSystemPrompt env block", () => {
	it("has only the four base entries without git data", () => {
		for (const mode of ["act", "plan", "yolo"] as const) {
			const env = envBlock(buildClineSystemPrompt({ ...BASE_OPTIONS, mode }));
			expect(env).toContain("4. Working Directory: /workspace/project\n</env>");
			expect(env).not.toContain("Git");
			expect(env).not.toContain("{{");
		}
	});

	it("adds the git snapshot after the working directory", () => {
		const env = envBlock(
			buildClineSystemPrompt({
				...BASE_OPTIONS,
				mode: "act",
				gitSnapshot: {
					branch: "feature/env",
					defaultBranch: "main",
					status: [" M src/app.ts", "?? notes.md"],
					statusOmitted: 3,
					recentCommits: ["abc1234 Add the env block", "def5678 Fix a typo"],
				},
			}),
		);

		expect(env).toBe(
			[
				"<env>",
				"1. Platform: linux",
				`2. Date: ${new Date().toLocaleDateString()}`,
				"3. IDE: VS Code",
				"4. Working Directory: /workspace/project",
				"5. Git (snapshot taken when this conversation started. It is not updated: run git commands when you need the current state.)",
				"   Current branch: feature/env",
				"   Default branch: main",
				"   Status:",
				"      M src/app.ts",
				"     ?? notes.md",
				"     ... and 3 more",
				"   Recent commits:",
				"     abc1234 Add the env block",
				"     def5678 Fix a typo",
				"</env>",
			].join("\n"),
		);
	});

	it("adds the snapshot to the yolo prompt for any provider", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "yolo",
			providerId: "pliny",
			gitSnapshot: { branch: "main", status: [] },
		});
		const env = envBlock(prompt);
		expect(env).toContain("   Current branch: main");
		expect(env).toContain("   Status: clean");
		expect(prompt).not.toContain("{{GIT_SNAPSHOT}}");
	});

	it("describes a detached HEAD and a status that timed out", () => {
		const detached = envBlock(
			buildClineSystemPrompt({
				...BASE_OPTIONS,
				gitSnapshot: { head: "abc1234", statusIncomplete: true },
			}),
		);
		expect(detached).toContain(
			"   Current branch: none (detached HEAD at abc1234)",
		);
		expect(detached).toContain(
			"   Status: not available (git status did not finish in time)",
		);

		const partial = envBlock(
			buildClineSystemPrompt({
				...BASE_OPTIONS,
				gitSnapshot: {
					branch: "main",
					status: [" M a.ts"],
					statusIncomplete: true,
				},
			}),
		);
		expect(partial).toContain(
			"     ... the list is incomplete (git status did not finish in time)",
		);
	});

	it("falls back to the WorkspaceInfo git fields when no snapshot is given", () => {
		const env = envBlock(
			buildClineSystemPrompt({
				...BASE_OPTIONS,
				latestGitBranchName: "main",
				latestGitCommitHash: "0123456789abcdef0123456789abcdef01234567",
			}),
		);
		expect(env).toContain("   Current branch: main");
		expect(env).not.toContain("Status");

		const detached = envBlock(
			buildClineSystemPrompt({
				...BASE_OPTIONS,
				latestGitCommitHash: "0123456789abcdef0123456789abcdef01234567",
			}),
		);
		expect(detached).toContain("detached HEAD at 0123456");
	});

	it("inserts repository text literally", () => {
		// "$&" and "$'" are replacement patterns for String.replace, and a
		// commit subject may spell out one of the template's own placeholders.
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			mode: "plan",
			rules: "# Custom Rules\n\nBe brief.",
			gitSnapshot: {
				branch: "main",
				recentCommits: ["abc1234 Cost is $& and $' {{CLINE_RULES}}"],
			},
		});
		expect(envBlock(prompt)).toContain(
			"     abc1234 Cost is $& and $' {{CLINE_RULES}}",
		);
		expect(prompt.indexOf("Be brief.")).toBeGreaterThan(
			prompt.indexOf("</env>"),
		);
		expect(prompt).toContain(MODE_TAG_INSTRUCTIONS);
	});

	it("leaves an explicit override prompt alone", () => {
		const prompt = buildClineSystemPrompt({
			...BASE_OPTIONS,
			overridePrompt: "You are a custom agent.",
			gitSnapshot: { branch: "main" },
		});
		expect(prompt).toBe("You are a custom agent.");
	});
});
