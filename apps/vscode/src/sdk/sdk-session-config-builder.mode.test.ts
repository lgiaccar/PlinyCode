import type { CoreSessionConfig } from "@plinycode/core"
import { describe, expect, it, vi } from "vitest"
import type { RouterInstallDeps } from "./router/router-integration"
import { SdkSessionConfigBuilder } from "./sdk-session-config-builder"

// The router's mode is read through the deps the builder hands installRouter,
// so the router is replaced here to capture them.
const mocks = vi.hoisted(() => ({
	buildSessionConfig: vi.fn(),
	installed: [] as RouterInstallDeps[],
}))

vi.mock("./cline-session-factory", () => ({
	buildSessionConfig: mocks.buildSessionConfig,
}))

vi.mock("./hooks-adapter", () => ({
	buildAgentHooks: vi.fn(() => ({})),
}))

vi.mock("./router/router-integration", () => ({
	installRouter: vi.fn((config: CoreSessionConfig, deps: RouterInstallDeps) => {
		mocks.installed.push(deps)
		return config
	}),
}))

function makeBuilder(globalMode: string, isOffTheRecordTurn?: (sessionId: string | undefined) => boolean) {
	return new SdkSessionConfigBuilder({
		stateManager: { getGlobalSettingsKey: (key: string) => (key === "mode" ? globalMode : undefined) } as never,
		emitHookMessage: vi.fn(),
		emitRow: vi.fn(),
		nextMessageTs: () => 1,
		isOffTheRecordTurn,
	})
}

async function routerModeFor(builder: SdkSessionConfigBuilder, mode: "act" | "plan" | "ask") {
	mocks.buildSessionConfig.mockResolvedValueOnce({ hooks: {} })
	const config = await builder.build({ cwd: "/workspace", mode })
	const deps = mocks.installed[mocks.installed.length - 1]
	return { mode: deps.getMode(), sessionId: config.sessionId }
}

describe("SdkSessionConfigBuilder router mode", () => {
	it("follows the session's own mode, not the mode switch", async () => {
		// The switch says act while this session was built in plan: a background
		// or CI Board task keeps the mode it was started in.
		expect((await routerModeFor(makeBuilder("act"), "plan")).mode).toBe("plan")
		expect((await routerModeFor(makeBuilder("act"), "ask")).mode).toBe("plan")
		expect((await routerModeFor(makeBuilder("plan"), "act")).mode).toBe("act")
	})

	it("routes a side question like plan mode, by the session that asks it", async () => {
		const asking = new Set<string>()
		const builder = makeBuilder("act", (sessionId) => sessionId !== undefined && asking.has(sessionId))
		const first = await routerModeFor(builder, "act")
		expect(first.mode).toBe("act")

		asking.add(first.sessionId ?? "")
		const deps = mocks.installed[mocks.installed.length - 1]
		expect(deps.getMode()).toBe("plan")

		// Another session's router is not affected by the first one's side question.
		const second = await routerModeFor(builder, "act")
		expect(second.mode).toBe("act")
	})
})
