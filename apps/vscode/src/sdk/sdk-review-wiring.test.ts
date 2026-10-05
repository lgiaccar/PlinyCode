import { beforeEach, describe, expect, it, vi } from "vitest"
import { SdkCheckpointCoordinator } from "./sdk-checkpoint-coordinator"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	installRouter: vi.fn(),
	settings: new Map<string, unknown>(),
}))

vi.mock("vscode", () => ({
	workspace: {
		getConfiguration: (section: string) => ({
			get: (key: string, fallback?: unknown) =>
				mocks.settings.has(`${section}.${key}`) ? mocks.settings.get(`${section}.${key}`) : fallback,
		}),
	},
}))

vi.mock("./cline-session-factory", () => ({ buildSessionConfig: mocks.buildSessionConfig }))
vi.mock("./hooks-adapter", () => ({ buildAgentHooks: vi.fn(() => ({})) }))
vi.mock("./instruction-context-rows", () => ({ installInstructionContextRows: vi.fn() }))
vi.mock("./router/router-integration", () => ({ installRouter: mocks.installRouter }))

describe("reviewer pass wiring", () => {
	beforeEach(() => {
		mocks.settings.clear()
		mocks.installRouter.mockClear()
	})

	async function routerDeps(getRunChanges?: (sessionId: string) => Promise<undefined>) {
		mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {}, sessionId: "session-9" })
		const builder = new SdkSessionConfigBuilder({
			stateManager: { getGlobalSettingsKey: () => "act" } as never,
			emitHookMessage: vi.fn(),
			emitRow: vi.fn(),
			nextMessageTs: () => 1,
			...(getRunChanges ? { getRunChanges } : {}),
		})
		await builder.build({ cwd: "/workspace", mode: "act" })
		return mocks.installRouter.mock.calls[0]?.[1] as {
			reviewEnabled: () => boolean
			getRunChanges?: () => Promise<unknown>
		}
	}

	it("reads plinycode.review.beforeFinish on every run, on by default", async () => {
		const deps = await routerDeps()
		expect(deps.reviewEnabled()).toBe(true)
		mocks.settings.set("plinycode.review.beforeFinish", false)
		expect(deps.reviewEnabled()).toBe(false)
		mocks.settings.set("plinycode.review.beforeFinish", true)
		expect(deps.reviewEnabled()).toBe(true)
	})

	it("asks for the changes of the session the config was built for", async () => {
		const getRunChanges = vi.fn(async () => undefined)
		const deps = await routerDeps(getRunChanges)
		await deps.getRunChanges?.()
		expect(getRunChanges).toHaveBeenCalledWith("session-9")
		// Without a host that can compare checkpoints, the router is given nothing to call.
		mocks.installRouter.mockClear()
		expect((await routerDeps()).getRunChanges).toBeUndefined()
	})
})

describe("SdkCheckpointCoordinator.getRunChanges", () => {
	function createCoordinator(options: {
		history: Array<{ ref: string; createdAt: number; runCount: number }>
		compareCheckpoint: ReturnType<typeof vi.fn>
		tempHost?: unknown
	}) {
		const sessionRecord = { cwd: "/proj", metadata: { checkpoint: { history: options.history } } }
		return new SdkCheckpointCoordinator({
			sessions: {
				getActiveSession: () =>
					({
						sessionId: "session-1",
						sdkHost: { compareCheckpoint: options.compareCheckpoint, get: async () => sessionRecord },
					}) as never,
			} as never,
			getWorkspaceRoot: async () => "/proj",
			createTempSessionHost: () =>
				options.tempHost ? Promise.resolve(options.tempHost as never) : Promise.reject(new Error("not needed")),
		} as never)
	}

	it("compares the latest checkpoint with the working tree, afresh on every call", async () => {
		const diffs = [{ filePath: "/proj/src/a.ts", leftContent: "a\n", rightContent: "b\n" }]
		const compareCheckpoint = vi.fn().mockResolvedValue({ diffs })
		const coordinator = createCoordinator({
			history: [
				{ ref: "r1", createdAt: 1, runCount: 1 },
				{ ref: "r3", createdAt: 3, runCount: 3 },
				{ ref: "r2", createdAt: 2, runCount: 2 },
			],
			compareCheckpoint,
		})
		expect(await coordinator.getRunChanges("session-1")).toEqual({ cwd: "/proj", diffs })
		expect(compareCheckpoint).toHaveBeenCalledWith({ sessionId: "session-1", checkpointRunCount: 3, cwd: "/proj" })
		// The working tree moves while the run goes on: nothing may be cached.
		await coordinator.getRunChanges("session-1")
		expect(compareCheckpoint).toHaveBeenCalledTimes(2)
	})

	it("returns nothing when the session has no checkpoint", async () => {
		const compareCheckpoint = vi.fn()
		const coordinator = createCoordinator({ history: [], compareCheckpoint })
		expect(await coordinator.getRunChanges("session-1")).toBeUndefined()
		expect(compareCheckpoint).not.toHaveBeenCalled()
	})

	it("reads a session that is not the active one through a temporary host, and disposes it", async () => {
		const diffs = [{ filePath: "/bg/a.ts", leftContent: "", rightContent: "x\n" }]
		const tempHost = {
			compareCheckpoint: vi.fn().mockResolvedValue({ diffs }),
			get: async () => ({ cwd: "/bg", metadata: { checkpoint: { history: [{ ref: "r", createdAt: 1, runCount: 2 }] } } }),
			dispose: vi.fn(async () => undefined),
		}
		const activeCompare = vi.fn()
		const coordinator = createCoordinator({ history: [], compareCheckpoint: activeCompare, tempHost })
		expect(await coordinator.getRunChanges("background-session")).toEqual({ cwd: "/bg", diffs })
		expect(activeCompare).not.toHaveBeenCalled()
		expect(tempHost.dispose).toHaveBeenCalledTimes(1)
	})
})
