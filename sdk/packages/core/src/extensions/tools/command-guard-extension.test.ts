import type {
	AgentBeforeToolContext,
	AgentRuntimeStateSnapshot,
	AgentTool,
} from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import {
	ASK_MODE_COMMAND_GUARD_EXTENSION_NAME,
	createAskModeCommandGuardExtension,
	createPlanModeCommandGuardExtension,
	PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME,
} from "./command-guard-extension";

function makeSnapshot(): AgentRuntimeStateSnapshot {
	return {
		agentId: "agent-1",
		conversationId: "conv-1",
		runId: "run-1",
		status: "running",
		iteration: 2,
		messages: [],
		pendingToolCalls: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			totalTokens: 0,
		},
	} as unknown as AgentRuntimeStateSnapshot;
}

function makeContext(toolName: string, input: unknown): AgentBeforeToolContext {
	return {
		snapshot: makeSnapshot(),
		tool: { name: toolName } as AgentTool,
		toolCall: {
			type: "tool-call",
			toolCallId: "tool-call-1",
			toolName,
			input,
		},
		input,
	};
}

async function runBeforeTool(
	extension: ReturnType<typeof createPlanModeCommandGuardExtension>,
	context: AgentBeforeToolContext,
) {
	const hook = extension.hooks?.beforeTool;
	expect(hook).toBeTypeOf("function");
	return hook?.(context);
}

describe("plan-mode command-guard extension", () => {
	it("declares the hooks capability under a stable name", () => {
		const extension = createPlanModeCommandGuardExtension();
		expect(extension.name).toBe(PLAN_MODE_COMMAND_GUARD_EXTENSION_NAME);
		expect(extension.manifest.capabilities).toContain("hooks");
	});

	it("skips run_commands calls containing a file-editing command", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["rm -rf build"] }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.stop).toBeUndefined();
		expect(result?.reason).toContain("PLAN MODE");
		expect(result?.reason).toContain("`rm`");
	});

	it("rejects the whole call when any command in a batch is blocked", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["git status", "echo hi > out.txt"],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("output redirection");
	});

	it("allows read-only run_commands calls", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: ["ls -la", "git log --oneline", "grep -rn foo src/"],
			}),
		);

		expect(result).toBeUndefined();
	});

	it("guards structured command input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", {
				commands: [{ command: "git", args: ["checkout", "main"] }],
			}),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("`git checkout`");
	});

	it("allows editor writes to markdown files", async () => {
		const extension = createPlanModeCommandGuardExtension();
		for (const path of [
			"plans/auth/PLAN.md",
			"plans/auth/01-api.md",
			"NOTES.MARKDOWN",
		]) {
			const result = await runBeforeTool(
				extension,
				makeContext("editor", { path, new_text: "# Plan" }),
			);
			expect(result).toBeUndefined();
		}
	});

	it("rejects editor writes to non-markdown files", async () => {
		const extension = createPlanModeCommandGuardExtension();
		for (const path of ["src/index.ts", "README", "plans/PLAN.md.bak"]) {
			const result = await runBeforeTool(
				extension,
				makeContext("editor", { path, new_text: "x" }),
			);
			expect(result?.skip).toBe(true);
			expect(result?.reason).toContain("PLAN MODE");
			expect(result?.reason).toContain(`\`${path}\``);
		}
	});

	it("rejects editor calls without a path", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("editor", { new_text: "x" }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("without a path");
	});

	it("allows apply_patch when every file is markdown", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const patch = [
			"*** Begin Patch",
			"*** Add File: plans/x/PLAN.md",
			"+# Plan",
			"*** Update File: plans/x/01-step.md",
			"@@",
			"-a",
			"+b",
			"*** End Patch",
		].join("\n");

		expect(
			await runBeforeTool(
				extension,
				makeContext("apply_patch", { input: patch }),
			),
		).toBeUndefined();
		expect(
			await runBeforeTool(extension, makeContext("apply_patch", patch)),
		).toBeUndefined();
	});

	it("rejects apply_patch touching a non-markdown file", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const patch = [
			"*** Begin Patch",
			"*** Add File: plans/x/PLAN.md",
			"+# Plan",
			"*** Update File: src/app.ts",
			"*** Move to: src/app.md",
			"*** End Patch",
		].join("\n");
		const result = await runBeforeTool(
			extension,
			makeContext("apply_patch", { input: patch }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("`src/app.ts`");
	});

	it("rejects apply_patch with no parseable file header", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("apply_patch", { input: "garbage" }),
		);

		expect(result?.skip).toBe(true);
	});

	it("ignores other tools", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("read_files", { files: [{ path: "/tmp/rm" }] }),
		);

		expect(result).toBeUndefined();
	});

	it("lets the tool report its own error for unparseable input", async () => {
		const extension = createPlanModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { bogus: 42 }),
		);

		expect(result).toBeUndefined();
	});
});

describe("ask-mode command-guard extension", () => {
	it("declares the hooks capability under a stable name", () => {
		const extension = createAskModeCommandGuardExtension();
		expect(extension.name).toBe(ASK_MODE_COMMAND_GUARD_EXTENSION_NAME);
		expect(extension.manifest.capabilities).toContain("hooks");
	});

	it("rejects every editor write, markdown included", async () => {
		const extension = createAskModeCommandGuardExtension();
		for (const path of ["src/app.ts", "plans/x/PLAN.md", "README.md"]) {
			const result = await runBeforeTool(
				extension,
				makeContext("editor", { path, new_text: "x" }),
			);

			expect(result?.skip).toBe(true);
			expect(result?.stop).toBeUndefined();
			expect(result?.reason).toContain("ASK MODE");
			expect(result?.reason).toContain(`\`${path}\``);
		}
	});

	it("rejects apply_patch and names the first file it touches", async () => {
		const extension = createAskModeCommandGuardExtension();
		const patch = [
			"*** Begin Patch",
			"*** Add File: docs/notes.md",
			"+# Notes",
			"*** End Patch",
		].join("\n");
		const result = await runBeforeTool(
			extension,
			makeContext("apply_patch", { input: patch }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("`docs/notes.md`");
		expect(
			(await runBeforeTool(extension, makeContext("apply_patch", "garbage")))
				?.skip,
		).toBe(true);
	});

	it("skips run_commands calls containing a file-editing command", async () => {
		const extension = createAskModeCommandGuardExtension();
		const result = await runBeforeTool(
			extension,
			makeContext("run_commands", { commands: ["echo hi > out.txt"] }),
		);

		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("ASK MODE");
		expect(result?.reason).not.toContain("PLAN MODE");
	});

	it("lets read-only commands and other tools through", async () => {
		const extension = createAskModeCommandGuardExtension();
		expect(
			await runBeforeTool(
				extension,
				makeContext("run_commands", { commands: ["git status", "ls -la"] }),
			),
		).toBeUndefined();
		expect(
			await runBeforeTool(
				extension,
				makeContext("read_files", { files: [{ path: "src/app.ts" }] }),
			),
		).toBeUndefined();
	});
});
