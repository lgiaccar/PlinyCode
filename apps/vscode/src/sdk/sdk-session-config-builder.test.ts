import { describe, expect, it, vi } from "vitest"
import { DEFAULT_ADVISOR_SETTINGS } from "./advisor/advisor-settings"
import { ConversationGitSnapshots } from "./context/conversation-git-snapshots"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	buildAgentHooks: vi.fn(() => ({})),
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: mocks.buildAgentHooks,
}))

describe("SdkSessionConfigBuilder", () => {
	it("never exposes a switch_to_act_mode tool, even in plan mode", async () => {
		// Matches the legacy extension: the model cannot switch plan -> act
		// itself; the user must flip the Plan/Act toggle.
		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
		})

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const planConfig = await builder.build({ cwd: "/workspace", mode: "plan" })
		expect(planConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)

		mocks.buildSessionConfig.mockResolvedValueOnce({
			extraTools: [],
			hooks: {},
		})
		const actConfig = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(actConfig.extraTools?.some((tool) => tool.name === "switch_to_act_mode")).toBe(false)
	})

	it("wires the agent hooks into the SDK config", async () => {
		const hooks = { beforeModel: vi.fn() }
		mocks.buildAgentHooks.mockReturnValueOnce(hooks)
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(config.hooks).toBe(hooks)
	})

	it("passes the mistake-limit callback into the SDK config without overriding SDK execution defaults", async () => {
		const onConsecutiveMistakeLimitReached = vi.fn()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, execution: { maxRetries: 1 } })

		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: vi.fn(() => 3) } as never,
			emitHookMessage: vi.fn(),
			onConsecutiveMistakeLimitReached,
		})

		const config = await builder.build({ cwd: "/workspace", mode: "act" })

		expect(config.execution).toEqual({ maxRetries: 1 })
		const context = { iteration: 1, consecutiveMistakes: 3, maxConsecutiveMistakes: 3, reason: "api_error" as const }
		await config.onConsecutiveMistakeLimitReached?.(context)
		expect(onConsecutiveMistakeLimitReached).toHaveBeenCalledWith(context)
	})

	it("assigns a session id when the config has none, and keeps an existing one", async () => {
		const builder = new SdkSessionConfigBuilder({ stateManager: {} as never, emitHookMessage: vi.fn() })

		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
		const fresh = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(fresh.sessionId).toEqual(expect.any(String))
		expect(fresh.sessionId).not.toBe("")

		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, sessionId: "existing" })
		const existing = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(existing.sessionId).toBe("existing")
	})

	describe("git snapshot", () => {
		const SNAPSHOT = { branch: "feature/env", status: [" M src/app.ts"] }

		function makeBuilder(getConversationId: () => string | undefined) {
			const gather = vi.fn(async (_cwd: string) => SNAPSHOT)
			const gitSnapshots = new ConversationGitSnapshots({
				isEnabled: () => true,
				gather,
				readStored: async () => undefined,
			})
			const builder = new SdkSessionConfigBuilder({
				stateManager: {} as never,
				emitHookMessage: vi.fn(),
				gitSnapshots,
				getConversationId,
			})
			return { builder, gather, gitSnapshots }
		}

		it("is gathered once per conversation and passed to every later build", async () => {
			let displayedTask: string | undefined
			const { builder, gather, gitSnapshots } = makeBuilder(() => displayedTask)

			// A new task: nothing is displayed yet, and the builder picks the session id.
			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
			const started = await builder.build({ cwd: "/workspace", mode: "act" })
			expect(mocks.buildSessionConfig).toHaveBeenLastCalledWith({ cwd: "/workspace", mode: "act", gitSnapshot: SNAPSHOT })
			expect(gitSnapshots.sessionMetadata(started.sessionId)).toEqual({ gitSnapshot: SNAPSHOT })

			// Mode switch, MCP tool change, resume: the task is displayed, and the
			// caller pins the session id after the build.
			displayedTask = started.sessionId
			for (const mode of ["plan", "act", "ask"] as const) {
				mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
				const rebuilt = await builder.build({ cwd: "/workspace", mode })
				rebuilt.sessionId = displayedTask
				expect(mocks.buildSessionConfig).toHaveBeenLastCalledWith({ cwd: "/workspace", mode, gitSnapshot: SNAPSHOT })
			}

			expect(gather).toHaveBeenCalledTimes(1)
			expect(gather).toHaveBeenCalledWith("/workspace")
		})

		it("gathers again only for the next new conversation", async () => {
			let displayedTask: string | undefined
			const { builder, gather } = makeBuilder(() => displayedTask)

			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
			displayedTask = (await builder.build({ cwd: "/workspace", mode: "act" })).sessionId
			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
			await builder.build({ cwd: "/workspace", mode: "plan" })
			expect(gather).toHaveBeenCalledTimes(1)

			// "New Task" clears the displayed task before the next config is built.
			displayedTask = undefined
			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
			await builder.build({ cwd: "/other", mode: "act" })
			expect(gather).toHaveBeenCalledTimes(2)
			expect(gather).toHaveBeenLastCalledWith("/other")
		})

		it("leaves the input alone when the conversation has no snapshot", async () => {
			const gitSnapshots = new ConversationGitSnapshots({
				isEnabled: () => false,
				gather: vi.fn(),
				readStored: async () => undefined,
			})
			const builder = new SdkSessionConfigBuilder({ stateManager: {} as never, emitHookMessage: vi.fn(), gitSnapshots })
			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

			await builder.build({ cwd: "/workspace", mode: "act" })

			expect(mocks.buildSessionConfig).toHaveBeenLastCalledWith({ cwd: "/workspace", mode: "act" })
		})
	})

	it("drops hook rows and skips the mistake-limit row for a background session", async () => {
		const emitHookMessage = vi.fn()
		const onConsecutiveMistakeLimitReached = vi.fn()
		const background = new Set<string>()
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })

		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage,
			onConsecutiveMistakeLimitReached,
			isBackgroundSession: (sessionId) => sessionId !== undefined && background.has(sessionId),
		})
		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		// Rebuilds overwrite the id after build(); the check must follow it.
		config.sessionId = "task-1"
		const hookEmitter = (mocks.buildAgentHooks.mock.calls.at(-1) as unknown as [unknown, (m: unknown) => void])[1]

		hookEmitter({ ts: 1 })
		expect(emitHookMessage).toHaveBeenCalledTimes(1)

		background.add("task-1")
		hookEmitter({ ts: 2 })
		expect(emitHookMessage).toHaveBeenCalledTimes(1)
		const decision = await config.onConsecutiveMistakeLimitReached?.({
			iteration: 1,
			consecutiveMistakes: 3,
			maxConsecutiveMistakes: 3,
			reason: "api_error",
		})
		expect(decision).toMatchObject({ action: "stop" })
		expect(onConsecutiveMistakeLimitReached).not.toHaveBeenCalled()
	})

	it("installs the advisor tool, hidden from the model unless the conversation is offered it", async () => {
		const builder = new SdkSessionConfigBuilder({
			stateManager: {} as never,
			emitHookMessage: vi.fn(),
			advisor: { getSettings: () => DEFAULT_ADVISOR_SETTINGS, checkBudget: async () => undefined },
		})
		const tools = [
			{ name: "read_files", description: "", inputSchema: {} },
			{ name: "ask_advisor", description: "", inputSchema: {} },
		]
		const shownTo = async (modelId: string) => {
			mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, modelId, extraTools: [] })
			const config = await builder.build({ cwd: "/workspace", mode: "act" })
			expect(config.extraTools?.map((tool) => tool.name)).toEqual(["ask_advisor"])
			const result = await config.hooks?.beforeModel?.({ snapshot: {}, request: { messages: [], tools } } as never)
			return (result?.tools ?? tools).map((tool) => tool.name)
		}

		expect(await shownTo("pliny/auto-paid-balanced")).toEqual(["read_files", "ask_advisor"])
		expect(await shownTo("pliny/auto-free")).toEqual(["read_files"])
	})

	it("adds no advisor tool when the host does not provide one", async () => {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, modelId: "pliny/auto-paid-balanced", extraTools: [] })
		const builder = new SdkSessionConfigBuilder({ stateManager: {} as never, emitHookMessage: vi.fn() })
		const config = await builder.build({ cwd: "/workspace", mode: "act" })
		expect(config.extraTools).toEqual([])
	})
})
