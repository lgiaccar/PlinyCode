import type { AgentToolContext } from "@plinycode/shared"
import { describe, expect, it, vi } from "vitest"
import { createWaitTool, WAIT_TOOL_NAME } from "./vscode-wait-tool"

function context(overrides: Partial<AgentToolContext> = {}): AgentToolContext {
	return { agentId: "a", iteration: 1, runId: "run-1", ...overrides }
}

/** A sleep that resolves at once and advances a fake clock by the requested time. */
function fakeClock() {
	let now = 1_700_000_000_000
	const sleeps: number[] = []
	const sleep = vi.fn(async (ms: number, signal?: AbortSignal) => {
		sleeps.push(ms)
		if (signal?.aborted) {
			return "aborted" as const
		}
		now += ms
		return "done" as const
	})
	return { sleep, sleeps, now: () => now }
}

describe("createWaitTool", () => {
	it("waits for the requested time and tells the model to check again", async () => {
		const clock = fakeClock()
		const tool = createWaitTool({ sleep: clock.sleep, now: clock.now })
		expect(tool.name).toBe(WAIT_TOOL_NAME)
		const result = await tool.execute({ seconds: 120, reason: "the build" }, context())
		expect(clock.sleeps).toEqual([120_000])
		expect(result).toContain("Waited 120 s for: the build.")
		expect(result).toContain("check progress with a tool call")
	})

	it("caps a single wait and says so", async () => {
		const clock = fakeClock()
		const tool = createWaitTool({ maxSeconds: 600, sleep: clock.sleep, now: clock.now })
		const result = await tool.execute({ seconds: 5000 }, context())
		expect(clock.sleeps).toEqual([600_000])
		expect(result).toContain("Waited 600 s.")
		expect(result).toContain("capped at 600 s")
	})

	it("spends a per-run budget and then refuses", async () => {
		const clock = fakeClock()
		const tool = createWaitTool({ maxSeconds: 600, maxTotalSecondsPerRun: 900, sleep: clock.sleep, now: clock.now })
		await tool.execute({ seconds: 600 }, context())
		const second = await tool.execute({ seconds: 600 }, context())
		expect(clock.sleeps).toEqual([600_000, 300_000])
		expect(second).toContain("Waited 300 s")
		await expect(tool.execute({ seconds: 10 }, context())).rejects.toThrow("Wait budget exhausted")
		// Another run has its own budget.
		await expect(tool.execute({ seconds: 10 }, context({ runId: "run-2" }))).resolves.toContain("Waited 10 s")
	})

	it("returns early when the run is cancelled", async () => {
		const clock = fakeClock()
		const tool = createWaitTool({ sleep: clock.sleep, now: clock.now })
		const controller = new AbortController()
		controller.abort()
		const result = await tool.execute({ seconds: 60 }, context({ signal: controller.signal }))
		expect(result).toContain("Wait cancelled")
	})

	it("returns early and says why when the user steers", async () => {
		const tool = createWaitTool()
		const steer = new AbortController()
		const pending = tool.execute(
			{ seconds: 600 },
			context({ signal: new AbortController().signal, userMessageSignal: steer.signal }),
		)
		steer.abort()
		const result = await pending
		expect(result).toContain("the user sent a new message")
	})

	it("treats nonsense input as the shortest wait", async () => {
		const clock = fakeClock()
		const tool = createWaitTool({ sleep: clock.sleep, now: clock.now })
		await tool.execute({ seconds: Number.NaN }, context())
		await tool.execute({ seconds: -5 }, context())
		expect(clock.sleeps).toEqual([1000, 1000])
	})
})
