import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { CreateHookRequest, DeleteHookRequest, ToggleHookRequest } from "@shared/proto/cline/file"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The engine's hook discovery (core's hook-file-config.ts), pointed at a temp
// directory: two global directories and the two workspace ones it reads.
const dirs = vi.hoisted(() => ({ root: "", workspace: "" }))

vi.mock("@plinycode/core", async (importOriginal) => {
	const nodePath = await import("node:path")
	const nodeFs = await import("node:fs")
	const events = new Set([
		"TaskStart",
		"TaskResume",
		"TaskCancel",
		"TaskComplete",
		"TaskError",
		"PreToolUse",
		"PostToolUse",
		"UserPromptSubmit",
		"SessionShutdown",
	])
	const globalDirs = () => [
		nodePath.join(dirs.root, "Documents", "Cline", "Hooks"),
		nodePath.join(dirs.root, ".cline", "hooks"),
	]
	const searchPaths = (workspacePath?: string) => [
		...globalDirs(),
		...(workspacePath
			? [nodePath.join(workspacePath, ".clinerules", "hooks"), nodePath.join(workspacePath, ".cline", "hooks")]
			: []),
	]
	return {
		...(await importOriginal<Record<string, unknown>>()),
		resolveHooksConfigSearchPaths: searchPaths,
		listHookConfigFiles: (workspacePath?: string) =>
			searchPaths(workspacePath)
				.filter((dir) => nodeFs.existsSync(dir))
				.flatMap((dir) =>
					nodeFs
						.readdirSync(dir)
						.map((name) => ({ name, fileName: nodePath.basename(name, nodePath.extname(name)) }))
						.filter((entry) => events.has(entry.fileName))
						.map((entry) => ({ fileName: entry.fileName, path: nodePath.join(dir, entry.name) })),
				),
	}
})

vi.mock("@/hosts/host-provider", () => ({
	HostProvider: { workspace: { getWorkspacePaths: async () => ({ paths: [dirs.workspace] }) } },
}))

import { createHook } from "../createHook"
import { deleteHook } from "../deleteHook"
import { refreshHooks } from "../refreshHooks"
import { toggleHook } from "../toggleHook"

function createController() {
	const values = {
		hooksEnabled: undefined as boolean | undefined,
		globalHooksToggles: {} as Record<string, boolean>,
		localHooksToggles: {} as Record<string, boolean>,
	}
	const stateManager = {
		getGlobalSettingsKey: (key: "hooksEnabled" | "globalHooksToggles") => values[key],
		getWorkspaceStateKey: (_key: "localHooksToggles") => values.localHooksToggles,
		setGlobalState: (_key: "globalHooksToggles", value: Record<string, boolean>) => {
			values.globalHooksToggles = value
		},
		setWorkspaceState: (_key: "localHooksToggles", value: Record<string, boolean>) => {
			values.localHooksToggles = value
		},
	}
	// biome-ignore lint/suspicious/noExplicitAny: only the state manager is used by the hook handlers
	return { values, controller: { stateManager } as any }
}

function writeHook(dir: string, fileName: string): string {
	fs.mkdirSync(dir, { recursive: true })
	const hookPath = path.join(dir, fileName)
	fs.writeFileSync(hookPath, "console.log('{}')\n")
	return hookPath
}

describe("hook management handlers", () => {
	let globalDocsDir: string
	let globalClineDir: string
	let workspaceDir: string

	beforeEach(() => {
		dirs.root = fs.mkdtempSync(path.join(os.tmpdir(), "hook-handlers-"))
		dirs.workspace = path.join(dirs.root, "my-project")
		fs.mkdirSync(dirs.workspace)
		globalDocsDir = path.join(dirs.root, "Documents", "Cline", "Hooks")
		globalClineDir = path.join(dirs.root, ".cline", "hooks")
		workspaceDir = path.join(dirs.workspace, ".clinerules", "hooks")
	})

	afterEach(() => {
		fs.rmSync(dirs.root, { recursive: true, force: true })
	})

	it("lists the hook files the engine discovers, with each one's toggle", async () => {
		const globalHook = writeHook(globalDocsDir, "TaskStart.ps1")
		const clineHook = writeHook(globalClineDir, "TaskError.js")
		const workspaceHook = writeHook(workspaceDir, "PreToolUse.js")
		const workspaceClineHook = writeHook(path.join(dirs.workspace, ".cline", "hooks"), "SessionShutdown.py")
		writeHook(workspaceDir, "README.md")
		const { values, controller } = createController()
		values.localHooksToggles = { [workspaceHook]: false }

		const toggles = await refreshHooks(controller)

		expect(toggles.globalHooks).toEqual([
			{ name: "TaskStart", enabled: true, absolutePath: globalHook },
			{ name: "TaskError", enabled: true, absolutePath: clineHook },
		])
		expect(toggles.workspaceHooks).toEqual([
			{
				workspaceName: "my-project",
				hooks: [
					{ name: "PreToolUse", enabled: false, absolutePath: workspaceHook },
					{ name: "SessionShutdown", enabled: true, absolutePath: workspaceClineHook },
				],
			},
		])
	})

	it("lists a workspace folder without hooks, so its first hook can be created", async () => {
		const toggles = await refreshHooks(createController().controller)
		expect(toggles.globalHooks).toEqual([])
		expect(toggles.workspaceHooks).toEqual([{ workspaceName: "my-project", hooks: [] }])
	})

	it("toggles a hook file by writing the toggle state, not the file mode (works on Windows)", async () => {
		const hookPath = writeHook(workspaceDir, "PreToolUse.js")
		const modeBefore = fs.statSync(hookPath).mode
		const { values, controller } = createController()

		const off = await toggleHook(
			controller,
			ToggleHookRequest.create({
				hookName: "PreToolUse",
				hookPath,
				isGlobal: false,
				enabled: false,
				workspaceName: "my-project",
			}),
		)

		expect(values.localHooksToggles).toEqual({ [hookPath]: false })
		expect(values.globalHooksToggles).toEqual({})
		expect(off.hooksToggles?.workspaceHooks[0].hooks[0]).toMatchObject({ absolutePath: hookPath, enabled: false })
		expect(fs.statSync(hookPath).mode).toBe(modeBefore)

		const on = await toggleHook(
			controller,
			ToggleHookRequest.create({
				hookName: "PreToolUse",
				hookPath,
				isGlobal: false,
				enabled: true,
				workspaceName: "my-project",
			}),
		)
		expect(values.localHooksToggles).toEqual({ [hookPath]: true })
		expect(on.hooksToggles?.workspaceHooks[0].hooks[0].enabled).toBe(true)
	})

	it("toggles a global hook named only by its event (an older webview)", async () => {
		const hookPath = writeHook(globalClineDir, "TaskComplete.js")
		const { values, controller } = createController()

		await toggleHook(controller, ToggleHookRequest.create({ hookName: "TaskComplete", isGlobal: true, enabled: false }))

		expect(values.globalHooksToggles).toEqual({ [hookPath]: false })
	})

	it("refuses to toggle or delete a path the engine does not run", async () => {
		const stray = writeHook(path.join(dirs.root, "elsewhere"), "PreToolUse.js")
		const { controller } = createController()

		await expect(
			toggleHook(
				controller,
				ToggleHookRequest.create({ hookName: "PreToolUse", hookPath: stray, isGlobal: true, enabled: false }),
			),
		).rejects.toThrow("does not exist")
		await expect(
			deleteHook(controller, DeleteHookRequest.create({ hookName: "PreToolUse", hookPath: stray, isGlobal: true })),
		).rejects.toThrow("does not exist")
		expect(fs.existsSync(stray)).toBe(true)
	})

	it("creates a hook from its template, switched off", async () => {
		const { values, controller } = createController()

		const response = await createHook(controller, CreateHookRequest.create({ hookName: "TaskError", isGlobal: true }))

		const fileName = process.platform === "win32" ? "TaskError.ps1" : "TaskError"
		const hookPath = path.join(globalDocsDir, fileName)
		expect(fs.readFileSync(hookPath, "utf-8")).toContain("TaskError Hook")
		expect(values.globalHooksToggles).toEqual({ [hookPath]: false })
		expect(response.hooksToggles?.globalHooks).toEqual([{ name: "TaskError", enabled: false, absolutePath: hookPath }])
	})

	it("only creates hooks for events the engine runs", async () => {
		const { controller } = createController()
		await expect(
			createHook(controller, CreateHookRequest.create({ hookName: "PreCompact", isGlobal: true })),
		).rejects.toThrow("Invalid hook type")
	})

	it("deletes a hook file and forgets its toggle", async () => {
		const hookPath = writeHook(workspaceDir, "PostToolUse.js")
		const { values, controller } = createController()
		values.localHooksToggles = { [hookPath]: false }

		const response = await deleteHook(
			controller,
			DeleteHookRequest.create({ hookName: "PostToolUse", hookPath, isGlobal: false, workspaceName: "my-project" }),
		)

		expect(fs.existsSync(hookPath)).toBe(false)
		expect(values.localHooksToggles).toEqual({})
		expect(response.hooksToggles?.workspaceHooks[0].hooks).toEqual([])
	})
})
