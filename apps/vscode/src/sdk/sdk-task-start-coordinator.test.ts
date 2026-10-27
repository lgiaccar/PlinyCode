import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StateManager } from "@/core/storage/StateManager"
import { isDirectory } from "@/utils/fs"
import { SdkTaskStartCoordinator, type SdkTaskStartCoordinatorOptions } from "./sdk-task-start-coordinator"

vi.mock("@/shared/services/Logger", () => ({
	Logger: {
		error: vi.fn(),
		log: vi.fn(),
		warn: vi.fn(),
	},
}))

vi.mock("@/utils/fs", () => ({
	isDirectory: vi.fn(),
}))

describe("SdkTaskStartCoordinator", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(isDirectory).mockResolvedValue(false)
	})

	it("initializes a new task, emits the task message, and sends the resolved prompt", async () => {
		const { coordinator, options, state } = makeCoordinator()

		const sessionId = await coordinator.initTask("hello @file", ["image.png"], ["a.ts"])

		expect(sessionId).toEqual(expect.any(String))
		expect(options.clearTask).toHaveBeenCalledOnce()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({
			prompt: "hello @file",
			images: ["image.png"],
			files: ["a.ts"],
			historyItem: undefined,
			taskSettings: undefined,
			cwd: "/workspace",
			mode: "act",
		})
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: "anthropic", modelId: "model", sessionId }),
			expect.objectContaining({
				prompt: "hello @file",
				images: ["image.png"],
				files: ["a.ts"],
				cwd: "/workspace",
				mode: "act",
			}),
		)
		expect(state.task?.taskId).toBe(sessionId)
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: sessionId, task: "hello @file", modelId: "model" }),
		)
		// Attachments must be on the authoritative task message so the webview's
		// optimistic pending copy (which carries them) gets confirmed and cleared.
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "task",
					text: "hello @file",
					images: ["image.png"],
					files: ["a.ts"],
				}),
			],
			{ type: "status", payload: { sessionId, status: "running" } },
		)
		expect(options.postStateToWebview).toHaveBeenCalledTimes(2)
		expect(options.messages.appendAndEmit.mock.invocationCallOrder[0]).toBeLessThan(
			options.sessions.startNewSession.mock.invocationCallOrder[0],
		)
		// The first state post carries the streaming TurnState to the webview (thinking
		// indicator) and must not wait for the potentially slow session startup.
		expect(options.postStateToWebview.mock.invocationCallOrder[0]).toBeLessThan(
			options.sessions.startNewSession.mock.invocationCallOrder[0],
		)
		expect(options.resolveContextMentions).toHaveBeenCalledWith("hello @file")
		expect(options.sessions.fireAndForgetSend).toHaveBeenCalledWith(
			expect.objectContaining({ send: expect.any(Function) }),
			sessionId,
			"resolved: hello @file",
			["image.png"],
			["a.ts"],
		)
	})


	it("pins agentPath before the first state push so the picker shows the correct agent immediately", async () => {
		const { coordinator, options } = makeCoordinator()
		const pinAgentPath = vi.fn()
		Object.assign(options.sessionConfigBuilder, { pinAgentPath })

		// Track invocation order to assert pin happens before the first state push.
		const order: string[] = []
		pinAgentPath.mockImplementation(() => {
			order.push("pinAgentPath")
		})
		options.postStateToWebview.mockImplementation(async () => {
			order.push("postStateToWebview")
		})

		const sessionId = await coordinator.initTask("start task", [], [], undefined, undefined, undefined, {
			agentPath: ".github/agents/reviewer.md",
		})

		expect(pinAgentPath).toHaveBeenCalledWith(sessionId, ".github/agents/reviewer.md")
		// The pin must happen before the first state push so the fire-and-forget
		// postStateToWebview() already sees the correct agentPath.
		const pinIdx = order.indexOf("pinAgentPath")
		const firstPostIdx = order.indexOf("postStateToWebview")
		expect(pinIdx).toBeLessThan(firstPostIdx)
		// agentPath is persisted to the history item as well.
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ agentPath: ".github/agents/reviewer.md" }),
		)
	})

	it("pins a task's model and titles its history entry", async () => {
		const { coordinator, options } = makeCoordinator()
		const pinModel = vi.fn()
		Object.assign(options.sessionConfigBuilder, { pinModel })

		const sessionId = await coordinator.initTask("[CI BOARD] long prompt", [], [], undefined, undefined, undefined, {
			modelId: "pliny/auto-free",
			title: "CI board: Fix CI on PR #12",
		})

		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(expect.objectContaining({ modelId: "pliny/auto-free" }))
		expect(pinModel).toHaveBeenCalledWith(sessionId, "pliny/auto-free")
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ pinnedModelId: "pliny/auto-free", task: "CI board: Fix CI on PR #12" }),
		)
	})

	it("starts a task straight into the background without touching the displayed one", async () => {
		vi.mocked(isDirectory).mockResolvedValue(true)
		const { coordinator, options } = makeCoordinator()
		const send = vi.fn().mockResolvedValue(undefined)
		const session = { sessionId: "bg-1", sdkHost: { send } }
		const background = { isFull: false, add: vi.fn(() => true), handleSendSettled: vi.fn() }
		Object.assign(options, { background })
		Object.assign(options.sessions, {
			startDetachedSession: vi.fn(async () => ({ startResult: { sessionId: "bg-1" }, session })),
			stopSession: vi.fn(),
		})
		Object.assign(options.sessionConfigBuilder, { pinModel: vi.fn() })
		const workspace = { path: "/wt", kind: "folder" as const, folders: ["/wt"] }

		const result = await coordinator.startBackgroundTask("fix it", workspace, {
			modelId: "pliny/auto-free",
			mode: "act",
			title: "CI auto-watch: Fix conflicts on PR #12",
		})

		expect(result).toEqual({ status: "started", conversationId: "bg-1" })
		expect(options.clearTask).not.toHaveBeenCalled()
		expect(options.setTask).not.toHaveBeenCalled()
		expect(options.sessions.startNewSession).not.toHaveBeenCalled()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(
			expect.objectContaining({ cwd: "/wt", mode: "act", modelId: "pliny/auto-free", newConversation: true }),
		)
		expect(background.add).toHaveBeenCalledWith(session, "CI auto-watch: Fix conflicts on PR #12")
		expect(send).toHaveBeenCalledWith({ sessionId: "bg-1", prompt: "fix it" })
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: "bg-1", pinnedModelId: "pliny/auto-free" }),
		)
		await vi.waitFor(() => expect(background.handleSendSettled).toHaveBeenCalledWith("bg-1"))

		background.isFull = true
		await expect(coordinator.startBackgroundTask("again", workspace)).resolves.toEqual({ status: "full" })
	})

	it("binds a new task to the window's workspace and records it as used", async () => {
		const { coordinator, options } = makeCoordinator()
		const windowWorkspace = { path: "/workspace", kind: "folder" as const, folders: ["/workspace"] }
		options.getWindowWorkspace = vi.fn().mockResolvedValue(windowWorkspace)
		options.setActiveTaskWorkspace = vi.fn()
		options.onWorkspaceUsed = vi.fn()

		const sessionId = await coordinator.initTask("hello")

		expect(options.setActiveTaskWorkspace).toHaveBeenCalledWith(windowWorkspace, "/workspace")
		expect(options.onWorkspaceUsed).toHaveBeenCalledWith(windowWorkspace)
		expect(options.createHistoryItemFromSession).toHaveBeenCalledWith(
			sessionId,
			"hello",
			"model",
			"/workspace",
			"/workspace",
			windowWorkspace,
		)
		expect(options.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionMetadata: { workspacePath: "/workspace", workspaceKind: "folder" },
			}),
		)
	})

	it("starts a task in a chosen workspace: its first folder is the cwd and the session is bound to it", async () => {
		vi.mocked(isDirectory).mockImplementation(async (folder) => folder === "/other/a")
		const { coordinator, options } = makeCoordinator()
		options.getWindowWorkspace = vi.fn().mockResolvedValue({ path: "/workspace", kind: "folder", folders: ["/workspace"] })
		options.setActiveTaskWorkspace = vi.fn()
		const chosen = { path: "/other/all.code-workspace", kind: "workspaceFile" as const, folders: ["/other/a", "/other/b"] }

		await coordinator.initTask("hello", undefined, undefined, undefined, undefined, chosen)

		expect(options.getWorkspaceRoot).not.toHaveBeenCalled()
		expect(options.setActiveTaskWorkspace).toHaveBeenCalledWith(chosen, "/other/a")
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/other/a" }))
		expect(options.createHistoryItemFromSession).toHaveBeenCalledWith(
			expect.any(String),
			"hello",
			"model",
			"/other/a",
			"/other/a",
			chosen,
		)
		expect(options.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionMetadata: { workspacePath: "/other/all.code-workspace", workspaceKind: "workspaceFile" },
			}),
		)
	})

	it("keeps a throwaway workspace out of the recent list when asked", async () => {
		vi.mocked(isDirectory).mockResolvedValue(true)
		const { coordinator, options } = makeCoordinator()
		options.setActiveTaskWorkspace = vi.fn()
		options.onWorkspaceUsed = vi.fn()
		const worktree = { path: "/repo.worktrees/feature", kind: "folder" as const, folders: ["/repo.worktrees/feature"] }

		const sessionId = await coordinator.initTask("fix CI", undefined, undefined, undefined, undefined, worktree, {
			recordRecentWorkspace: false,
		})

		expect(sessionId).toBeDefined()
		expect(options.setActiveTaskWorkspace).toHaveBeenCalledWith(worktree, "/repo.worktrees/feature")
		expect(options.onWorkspaceUsed).not.toHaveBeenCalled()
	})

	it("runs a task in a new worktree: the worktree is its cwd, its workspace and its metadata", async () => {
		const { coordinator, options } = makeCoordinator()
		const windowWorkspace = { path: "/workspace", kind: "folder" as const, folders: ["/workspace"] }
		const created = {
			repoRoot: "/workspace",
			branch: "plinycode/fix-login-ab12",
			path: "/workspace.worktrees/fix-login-ab12",
		}
		const emitHookMessage = vi.fn()
		Object.assign(options.messages, { emitHookMessage })
		options.getWindowWorkspace = vi.fn().mockResolvedValue(windowWorkspace)
		options.setActiveTaskWorkspace = vi.fn()
		options.onWorkspaceUsed = vi.fn()
		options.createTaskWorktree = vi.fn().mockResolvedValue({ ...created, notes: ["uncommitted changes stay behind"] })

		const sessionId = await coordinator.initTask("fix login", undefined, undefined, undefined, undefined, undefined, {
			worktree: true,
		})

		const worktree = { ...created, sourceWorkspacePath: "/workspace" }
		const bound = { path: created.path, kind: "folder", folders: [created.path] }
		expect(options.createTaskWorktree).toHaveBeenCalledWith({ folder: "/workspace", title: "fix login" })
		expect(options.setActiveTaskWorkspace).toHaveBeenCalledWith(bound, created.path)
		// The workspace the user picked is the recent one, not the throwaway worktree.
		expect(options.onWorkspaceUsed).toHaveBeenCalledWith(windowWorkspace)
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(expect.objectContaining({ cwd: created.path }))
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ cwd: created.path }),
		)
		expect(options.sessions.startNewSession).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionMetadata: { workspacePath: created.path, workspaceKind: "folder", worktree },
			}),
		)
		expect(options.createHistoryItemFromSession).toHaveBeenCalledWith(
			sessionId,
			"fix login",
			"model",
			created.path,
			created.path,
			bound,
		)
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.objectContaining({ id: sessionId, worktree }),
		)
		expect(emitHookMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				say: "info",
				text: expect.stringMatching(/plinycode\/fix-login-ab12[\s\S]*uncommitted changes stay behind/),
			}),
		)
	})

	it("leaves the workspace alone without the worktree option", async () => {
		const { coordinator, options } = makeCoordinator()
		options.createTaskWorktree = vi.fn()

		await coordinator.initTask("hello")

		expect(options.createTaskWorktree).not.toHaveBeenCalled()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }))
		expect(options.taskHistory.updateTaskHistoryItem).toHaveBeenCalledWith(
			expect.not.objectContaining({ worktree: expect.anything() }),
		)
	})

	it("starts nothing and shows an error row when the worktree cannot be created", async () => {
		const { coordinator, options } = makeCoordinator()
		options.createTaskWorktree = vi.fn().mockRejectedValue(new Error("/workspace is not in a git repository."))

		const sessionId = await coordinator.initTask("hello", undefined, undefined, undefined, undefined, undefined, {
			worktree: true,
		})

		expect(sessionId).toBeUndefined()
		expect(options.setTask).not.toHaveBeenCalled()
		expect(options.sessions.startNewSession).not.toHaveBeenCalled()
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					say: "error",
					text: expect.stringContaining(
						"Could not create a git worktree for this conversation: /workspace is not in a git",
					),
				}),
			],
			expect.anything(),
		)
	})

	it("refuses to start in a chosen workspace whose folder is missing", async () => {
		vi.mocked(isDirectory).mockResolvedValue(false)
		const { coordinator, options } = makeCoordinator()
		const chosen = { path: "/gone", kind: "folder" as const, folders: ["/gone"] }

		const sessionId = await coordinator.initTask("hello", undefined, undefined, undefined, undefined, chosen)

		expect(sessionId).toBeUndefined()
		expect(options.sessions.startNewSession).not.toHaveBeenCalled()
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[expect.objectContaining({ say: "error", text: expect.stringContaining("/gone does not exist") })],
			expect.anything(),
		)
	})

	it("resumes a task in its bound workspace", async () => {
		vi.mocked(isDirectory).mockResolvedValue(true)
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: "/other/a",
			workspacePath: "/other/all.code-workspace",
			workspaceKind: "workspaceFile",
		}
		const { coordinator, options } = makeCoordinator({ historyItem })
		options.setActiveTaskWorkspace = vi.fn()

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(options.setActiveTaskWorkspace).toHaveBeenCalledWith(
			{ path: "/other/all.code-workspace", kind: "workspaceFile", folders: ["/other/a"] },
			"/other/a",
		)
	})

	it("omits images/files from the task message when the task has no attachments", async () => {
		const { coordinator, options } = makeCoordinator()

		await coordinator.initTask("plain text task")

		const [emitted] = options.messages.appendAndEmit.mock.calls[0][0] as [Record<string, unknown>]
		expect(emitted).toMatchObject({ type: "say", say: "task", text: "plain text task" })
		expect(emitted).not.toHaveProperty("images")
		expect(emitted).not.toHaveProperty("files")
	})

	it("emits a plain chat error when session start fails (e.g. provider misconfigured)", async () => {
		const { coordinator, options, state } = makeCoordinator()
		const error = new Error("No model configured for provider openai")
		options.sessions.startNewSession.mockRejectedValue(error)

		const sessionId = await coordinator.initTask("do something")

		expect(sessionId).toBeUndefined()
		expect(state.task?.taskId).toEqual(expect.any(String))
		expect(options.messages.appendAndEmit).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					type: "say",
					say: "error",
					text: expect.stringContaining("No model configured for provider openai"),
				}),
			],
			{ type: "status", payload: { sessionId: state.task?.taskId, status: "error" } },
		)
		// One early post before session startup, one after the failure.
		expect(options.postStateToWebview).toHaveBeenCalledTimes(2)
	})

	it.each([true, false])("forwards task useAutoCondense=%s into SDK session config inputs", async (useAutoCondense) => {
		const { coordinator, options } = makeCoordinator()
		const taskSettings = { useAutoCondense }

		await coordinator.initTask("hello", undefined, undefined, undefined, taskSettings)

		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(
			expect.objectContaining({
				taskSettings,
			}),
		)
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				taskSettings,
			}),
		)
	})

	it("reinitializes an existing task with preserved initial messages", async () => {
		vi.mocked(isDirectory).mockResolvedValue(true)
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: "/task-cwd",
		}
		const { coordinator, options, state, tempHost } = makeCoordinator({ historyItem })

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(options.clearTask).toHaveBeenCalledOnce()
		expect(options.taskHistory.findHistoryItem).toHaveBeenCalledWith("task-1")
		expect(isDirectory).toHaveBeenCalledWith("/task-cwd")
		expect(options.getWorkspaceRoot).not.toHaveBeenCalled()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/task-cwd", mode: "act" })
		expect(options.createTempSessionHost).toHaveBeenCalledOnce()
		expect(options.loadInitialMessages).toHaveBeenCalledWith(tempHost, "task-1")
		expect(tempHost.dispose).toHaveBeenCalledWith("readMessages")
		expect(options.sessions.startNewSession).toHaveBeenCalledWith({
			config: expect.objectContaining({ providerId: "anthropic", modelId: "model" }),
			interactive: true,
			initialMessages: [{ role: "user", content: "hello" }],
			sessionMetadata: expect.objectContaining({
				title: "old task",
				modelId: "model",
			}),
		})
		expect(state.task?.taskId).toBe("session-123")
		expect(options.postStateToWebview).toHaveBeenCalledOnce()
	})

	it("builds the session in the mode the caller asks for, without reading the mode switch", async () => {
		const { coordinator, options } = makeCoordinator({ mode: "plan" })

		await coordinator.initTask("run the CI action", [], [], undefined, undefined, undefined, { mode: "act" })

		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith(expect.objectContaining({ mode: "act" }))
		expect(options.buildStartSessionInput).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mode: "act" }))
	})

	it("tells a new task when background tasks share its folder", async () => {
		const { coordinator, options } = makeCoordinator()
		const emitHookMessage = vi.fn()
		Object.assign(options.messages, { emitHookMessage })
		options.backgroundSessionsInFolder = vi.fn((cwd: string) => (cwd === "/workspace" ? 1 : 0))

		await coordinator.initTask("hello")

		expect(emitHookMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				say: "info",
				text: expect.stringContaining("Another task is still running in this folder"),
			}),
		)

		// Alone in the folder: no row.
		emitHookMessage.mockClear()
		options.backgroundSessionsInFolder = vi.fn(() => 0)
		await coordinator.initTask("hello again")
		expect(emitHookMessage).not.toHaveBeenCalled()
	})

	it("falls back to the workspace root when a stored task cwd is unavailable", async () => {
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: "/missing-task-cwd",
		}
		const { coordinator, options } = makeCoordinator({ historyItem })

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(isDirectory).toHaveBeenCalledWith("/missing-task-cwd")
		expect(options.getWorkspaceRoot).toHaveBeenCalledOnce()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: "/workspace", mode: "act" })
	})

	it("continues a conversation whose worktree was removed in the checkout it was branched from", async () => {
		const sub = path.join("/repo", "packages", "app")
		vi.mocked(isDirectory).mockImplementation(async (folder: string) => folder === sub)
		const historyItem: HistoryItem = {
			id: "task-1",
			task: "old task",
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			cwdOnTaskInitialization: path.join("/repo.worktrees", "fix-ab12", "packages", "app"),
			worktree: {
				repoRoot: "/repo",
				branch: "plinycode/fix-ab12",
				path: path.join("/repo.worktrees", "fix-ab12"),
				removedTs: 5,
			},
		}
		const { coordinator, options } = makeCoordinator({ historyItem })
		const emitHookMessage = vi.fn()
		Object.assign(options.messages, { emitHookMessage })

		await coordinator.reinitExistingTaskFromId("task-1")

		expect(options.getWorkspaceRoot).not.toHaveBeenCalled()
		expect(options.sessionConfigBuilder.build).toHaveBeenCalledWith({ cwd: sub, mode: "act" })
		expect(emitHookMessage).toHaveBeenCalledWith(
			expect.objectContaining({ say: "info", text: expect.stringContaining(`now works in ${sub}`) }),
		)
	})
})

function makeCoordinator(input: Partial<MakeCoordinatorInput> = {}) {
	const state: { task?: { taskId: string } } = {}
	const config = input.config ?? {
		providerId: "anthropic",
		modelId: "model",
		apiKey: "key",
	}
	const historyItem = input.historyItem ?? {
		id: "task-1",
		task: "old task",
		ts: 1,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
	}
	const tempHost = {
		readMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		dispose: vi.fn().mockResolvedValue(undefined),
	}
	const sdkHost = {
		send: vi.fn(),
	}
	const options = {
		stateManager: {
			getGlobalSettingsKey: vi.fn(() => input.mode ?? "act"),
		} as unknown as StateManager,
		sessions: {
			startNewSession: vi.fn((startInput?: { config?: { sessionId?: string } }) => ({
				startResult: { sessionId: startInput?.config?.sessionId ?? "session-123" },
				sdkHost,
			})),
			fireAndForgetSend: vi.fn(),
		},
		messages: {
			appendAndEmit: vi.fn(),
			emitSessionEvents: vi.fn(),
		},
		taskHistory: {
			findHistoryItem: vi.fn(() => (input.hasHistoryItem === false ? undefined : historyItem)),
			updateTaskHistory: vi.fn().mockResolvedValue([]),
			updateTaskHistoryItem: vi.fn().mockResolvedValue(undefined),
		},
		sessionConfigBuilder: {
			build: vi.fn().mockResolvedValue(config),
		},
		buildStartSessionInput: vi.fn((startConfig, startInput) => ({
			config: startConfig,
			interactive: true,
			prompt: startInput.prompt,
		})),
		createHistoryItemFromSession: vi.fn((sessionId, task, modelId, cwd) => ({
			id: sessionId,
			task,
			ts: 1,
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			modelId,
			cwdOnTaskInitialization: cwd,
		})),
		clearTask: vi.fn().mockResolvedValue(undefined),
		setTask: vi.fn((task) => {
			state.task = task as { taskId: string } | undefined
		}),
		onAskResponse: vi.fn().mockResolvedValue(undefined),
		onCancelTask: vi.fn().mockResolvedValue(undefined),
		getWorkspaceRoot: vi.fn().mockResolvedValue("/workspace"),
		createTempSessionHost: vi.fn().mockResolvedValue(tempHost),
		loadInitialMessages: vi.fn().mockResolvedValue([{ role: "user", content: "hello" }]),
		resolveContextMentions: vi.fn(async (text: string) => `resolved: ${text}`),
		postStateToWebview: vi.fn().mockResolvedValue(undefined),
	} as unknown as SdkTaskStartCoordinatorOptions & {
		sessions: SdkTaskStartCoordinatorOptions["sessions"] & {
			startNewSession: ReturnType<typeof vi.fn>
			fireAndForgetSend: ReturnType<typeof vi.fn>
		}
		messages: SdkTaskStartCoordinatorOptions["messages"] & {
			appendAndEmit: ReturnType<typeof vi.fn>
			emitSessionEvents: ReturnType<typeof vi.fn>
		}
		taskHistory: SdkTaskStartCoordinatorOptions["taskHistory"] & {
			findHistoryItem: ReturnType<typeof vi.fn>
			updateTaskHistory: ReturnType<typeof vi.fn>
			updateTaskHistoryItem: ReturnType<typeof vi.fn>
		}
		sessionConfigBuilder: SdkTaskStartCoordinatorOptions["sessionConfigBuilder"] & { build: ReturnType<typeof vi.fn> }
		buildStartSessionInput: ReturnType<typeof vi.fn>
		createHistoryItemFromSession: ReturnType<typeof vi.fn>
		clearTask: ReturnType<typeof vi.fn>
		createTempSessionHost: ReturnType<typeof vi.fn>
		loadInitialMessages: ReturnType<typeof vi.fn>
		resolveContextMentions: ReturnType<typeof vi.fn>
		postStateToWebview: ReturnType<typeof vi.fn>
	}

	return {
		coordinator: new SdkTaskStartCoordinator(options),
		options,
		state,
		tempHost,
	}
}

interface MakeCoordinatorInput {
	mode: "act" | "plan"
	config: {
		providerId: string
		modelId: string
		apiKey: string
	}
	historyItem: HistoryItem
	hasHistoryItem: boolean
}
