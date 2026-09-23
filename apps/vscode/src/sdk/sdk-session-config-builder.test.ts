import { describe, expect, it, vi } from "vitest"
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
})
