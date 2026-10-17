import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	resolveClineDir,
	resolveDocumentsClineDirectoryPath,
	setClineDir,
	setHomeDir,
} from "@plinycode/shared/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createHookConfigFileHooks,
	type HookStatusEvent,
} from "./hook-file-hooks";

// Hooks here are Node scripts (`.js` runs through `node`), so the tests do not
// depend on bash or python being on PATH.

/** A Node hook that drains stdin, then runs `body`. */
function nodeHook(body: string): string {
	return [
		"let input = '';",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		body,
		"});",
	].join("\n");
}

async function createWorkspaceWithHook(
	fileName: string,
	body: string,
): Promise<{ workspace: string; hookPath: string }> {
	const workspace = await mkdtemp(join(tmpdir(), "hooks-status-workspace-"));
	const hooksDir = join(workspace, ".clinerules", "hooks");
	await mkdir(hooksDir, { recursive: true });
	const hookPath = join(hooksDir, fileName);
	await writeFile(hookPath, body, "utf8");
	return { workspace, hookPath };
}

function snapshot() {
	return {
		agentId: "agent_1",
		conversationId: "conv_1",
		runId: "run_1",
		status: "running" as const,
		iteration: 1,
		messages: [],
		pendingToolCalls: [],
		usage: {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		},
	};
}

function beforeToolContext(input: unknown = { path: "README.md" }) {
	return {
		snapshot: snapshot(),
		tool: {
			name: "read_file",
			description: "",
			inputSchema: {},
			execute: async () => "",
		},
		toolCall: {
			type: "tool-call" as const,
			toolCallId: "call_1",
			toolName: "read_file",
			input,
		},
		input,
	};
}

describe("createHookConfigFileHooks status and filter", () => {
	const originalHomeDir = dirname(
		dirname(resolveDocumentsClineDirectoryPath()),
	);
	const originalClineDir = resolveClineDir();
	let isolatedRoot = "";
	const workspaces: string[] = [];

	beforeAll(async () => {
		isolatedRoot = await mkdtemp(join(tmpdir(), "hooks-status-home-"));
		const isolatedHomeDir = join(isolatedRoot, "home");
		const isolatedClineDir = join(isolatedRoot, "cline");
		await mkdir(isolatedHomeDir, { recursive: true });
		await mkdir(isolatedClineDir, { recursive: true });
		setHomeDir(isolatedHomeDir);
		setClineDir(isolatedClineDir);
	});

	afterAll(async () => {
		setHomeDir(originalHomeDir);
		setClineDir(originalClineDir);
		for (const workspace of workspaces) {
			await rm(workspace, { recursive: true, force: true });
		}
		if (isolatedRoot) {
			await rm(isolatedRoot, { recursive: true, force: true });
		}
	});

	async function workspaceWithHook(fileName: string, body: string) {
		const created = await createWorkspaceWithHook(fileName, body);
		workspaces.push(created.workspace);
		return created;
	}

	it("reports running then completed for a successful hook", async () => {
		const { workspace, hookPath } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook(
				"process.stdout.write(JSON.stringify({ contextModification: 'ok' }));",
			),
		);
		const events: HookStatusEvent[] = [];
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			onHookStatus: (event) => events.push(event),
		});

		const result = await hooks?.beforeTool?.(beforeToolContext());

		expect(result).toEqual({ appendContext: "ok" });
		expect(events.map((event) => event.status)).toEqual([
			"running",
			"completed",
		]);
		expect(events[0]).toEqual({
			hookName: "PreToolUse",
			hookPath,
			eventName: "tool_call",
			toolName: "read_file",
			status: "running",
		});
		expect(events[1]).toMatchObject({
			hookName: "PreToolUse",
			hookPath,
			eventName: "tool_call",
			toolName: "read_file",
			status: "completed",
			exitCode: 0,
		});
		expect(events[1]?.durationMs).toBeGreaterThanOrEqual(0);
		expect(events[1]?.error).toBeUndefined();
	});

	it("reports running then failed for a hook that exits non-zero", async () => {
		const { workspace } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook("process.stderr.write('boom'); process.exit(3);"),
		);
		const events: HookStatusEvent[] = [];
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			onHookStatus: (event) => events.push(event),
		});

		const result = await hooks?.beforeTool?.(beforeToolContext());

		expect(result).toBeUndefined();
		expect(events.map((event) => event.status)).toEqual(["running", "failed"]);
		expect(events[1]).toMatchObject({
			hookName: "PreToolUse",
			status: "failed",
			exitCode: 3,
		});
		// toContain: a debugger attached through NODE_OPTIONS adds its banner.
		expect(events[1]?.error).toContain("boom");
	});

	it("reports cancelled when a blocking hook cancels", async () => {
		const { workspace } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook(
				"process.stdout.write(JSON.stringify({ cancel: true, errorMessage: 'blocked' }));",
			),
		);
		const events: HookStatusEvent[] = [];
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			onHookStatus: (event) => events.push(event),
		});

		const result = await hooks?.beforeTool?.(beforeToolContext());

		expect(result).toEqual({ stop: true, reason: "blocked" });
		expect(events.map((event) => event.status)).toEqual([
			"running",
			"cancelled",
		]);
	});

	it("keeps running the hook when the status listener throws", async () => {
		const { workspace } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook(
				"process.stdout.write(JSON.stringify({ contextModification: 'still here' }));",
			),
		);
		const warnings: string[] = [];
		let calls = 0;
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			logger: {
				debug: () => {},
				log: (message: string) => {
					warnings.push(message);
				},
			},
			onHookStatus: () => {
				calls += 1;
				throw new Error("listener exploded");
			},
		});

		const result = await hooks?.beforeTool?.(beforeToolContext());

		expect(result).toEqual({ appendContext: "still here" });
		expect(calls).toBe(2);
		expect(
			warnings.filter((message) =>
				message.includes("hook status listener failed"),
			),
		).toHaveLength(2);
	});

	it("reports fire-and-forget hooks once they exit", async () => {
		const { workspace } = await workspaceWithHook(
			"TaskStart.js",
			nodeHook("process.exit(0);"),
		);
		const events: HookStatusEvent[] = [];
		let resolveTerminal: () => void = () => {};
		const terminal = new Promise<void>((resolve) => {
			resolveTerminal = resolve;
		});
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			// The default: TaskStart hooks are not awaited by the run.
			detachAsyncHooks: true,
			onHookStatus: (event) => {
				events.push(event);
				if (event.status !== "running") {
					resolveTerminal();
				}
			},
		});

		await hooks?.beforeRun?.({ snapshot: snapshot() });
		await terminal;

		expect(events.map((event) => event.status)).toEqual([
			"running",
			"completed",
		]);
		expect(events[1]).toMatchObject({
			hookName: "TaskStart",
			eventName: "agent_start",
			exitCode: 0,
		});
		expect(events[1]?.toolName).toBeUndefined();
	});

	it("skips hook files the filter rejects, evaluated on each run", async () => {
		const { workspace, hookPath } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook(
				"process.stdout.write(JSON.stringify({ contextModification: 'ran' }));",
			),
		);
		let enabled = false;
		const filtered: string[] = [];
		const events: HookStatusEvent[] = [];
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			hookFilter: (path) => {
				filtered.push(path);
				return enabled;
			},
			onHookStatus: (event) => events.push(event),
		});

		expect(await hooks?.beforeTool?.(beforeToolContext())).toBeUndefined();
		expect(filtered).toEqual([hookPath]);
		expect(events).toEqual([]);

		enabled = true;
		expect(await hooks?.beforeTool?.(beforeToolContext())).toEqual({
			appendContext: "ran",
		});
		expect(events.map((event) => event.status)).toEqual([
			"running",
			"completed",
		]);
	});

	it("runs the hook when the filter throws", async () => {
		const { workspace } = await workspaceWithHook(
			"PreToolUse.js",
			nodeHook(
				"process.stdout.write(JSON.stringify({ contextModification: 'ran' }));",
			),
		);
		const hooks = createHookConfigFileHooks({
			cwd: workspace,
			workspacePath: workspace,
			logger: { debug: () => {}, log: () => {} },
			hookFilter: () => {
				throw new Error("filter exploded");
			},
		});

		expect(await hooks?.beforeTool?.(beforeToolContext())).toEqual({
			appendContext: "ran",
		});
	});
});
