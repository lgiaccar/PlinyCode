import { describe, expect, it, vi } from "vitest"
import { ProcessRegistry } from "./process-registry"

function registration(overrides: Partial<Parameters<ProcessRegistry["register"]>[0]> = {}) {
	return {
		conversationId: "conversation-1",
		command: "npm run dev",
		cwd: "/workspace",
		source: "terminal" as const,
		logPath: "/tmp/log-1.log",
		kill: vi.fn(async () => {}),
		...overrides,
	}
}

describe("ProcessRegistry", () => {
	it("hands out short ids and lists the processes of one conversation", () => {
		const registry = new ProcessRegistry(() => 1000)
		const first = registry.register(registration())
		const second = registry.register(registration({ conversationId: "conversation-2", command: "bun test" }))
		const third = registry.register(registration({ command: "tsc --watch" }))

		expect([first.id, second.id, third.id]).toEqual(["p1", "p2", "p3"])
		expect(first).toMatchObject({ status: "running", startedAt: 1000, logPath: "/tmp/log-1.log", source: "terminal" })
		expect(registry.list("conversation-1").map((process) => process.id)).toEqual(["p1", "p3"])
		expect(registry.list().map((process) => process.id)).toEqual(["p1", "p2", "p3"])
		expect(registry.get("P2")?.command).toBe("bun test")
		expect(registry.get("p9")).toBeUndefined()
	})

	it("records an exit with its code, and notifies listeners", () => {
		let now = 1000
		const registry = new ProcessRegistry(() => now)
		const listener = vi.fn()
		registry.onDidChange(listener)
		const process = registry.register(registration())
		expect(listener).toHaveBeenCalledTimes(1)
		expect(registry.hasRunning("conversation-1")).toBe(true)

		now = 5000
		registry.markExited(process.id, 2)
		expect(registry.get(process.id)).toMatchObject({ status: "exited", exitCode: 2, endedAt: 5000 })
		expect(registry.hasRunning("conversation-1")).toBe(false)
		expect(listener).toHaveBeenCalledTimes(2)

		// An ended process does not change again.
		registry.markLost(process.id)
		registry.markExited(process.id, 0)
		expect(registry.get(process.id)?.status).toBe("exited")
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("keeps an unconfirmed stop running and allows another attempt", async () => {
		const registry = new ProcessRegistry()
		const kill = vi.fn(async () => {})
		const process = registry.register(registration({ kill }))

		await process.kill()

		expect(kill).toHaveBeenCalledOnce()
		expect(registry.get(process.id)).toMatchObject({ status: "running", stopRequested: true })
		expect(registry.get(process.id)?.endedAt).toBeUndefined()
		expect(registry.hasRunning("conversation-1")).toBe(true)
		await process.kill()
		expect(kill).toHaveBeenCalledTimes(2)
	})

	it("reports a failed stop without claiming termination, then retries", async () => {
		const registry = new ProcessRegistry()
		const stop = vi.fn().mockRejectedValueOnce(new Error("permission denied")).mockResolvedValue(undefined)
		const process = registry.register(registration({ kill: stop }))
		await registry.kill(process.id)
		expect(registry.get(process.id)).toMatchObject({ status: "running", stopError: "permission denied" })
		await registry.kill(process.id)
		expect(registry.get(process.id)).toMatchObject({ status: "running", stopError: undefined })
		expect(stop).toHaveBeenCalledTimes(2)
	})

	it("handles synchronous stop failures and notifies subscribers", async () => {
		const registry = new ProcessRegistry()
		const process = registry.register(
			registration({
				kill: () => {
					throw new Error("cannot interrupt")
				},
			}),
		)
		const listener = vi.fn()
		registry.onDidChange(listener)
		await registry.kill(process.id)
		expect(registry.get(process.id)).toMatchObject({ status: "running", stopError: "cannot interrupt" })
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("keeps lost observation unknown after a stop, but accepts a late exit", async () => {
		const registry = new ProcessRegistry(() => 5000)
		const process = registry.register(registration())
		await registry.kill(process.id)
		registry.markLost(process.id)
		expect(registry.get(process.id)?.status).toBe("lost")
		registry.markExited(process.id, 130)
		expect(registry.get(process.id)).toMatchObject({ status: "killed", exitCode: 130, endedAt: 5000 })
	})

	it("keeps the exit code of a process that ended because of a kill", async () => {
		const registry = new ProcessRegistry()
		let id = ""
		const process = registry.register(
			registration({
				kill: async () => {
					registry.markExited(id, 130)
				},
			}),
		)
		id = process.id

		const after = await registry.kill(process.id)

		expect(after).toMatchObject({ status: "killed", exitCode: 130 })
	})

	it("runs a kill once when it is asked for twice", async () => {
		const registry = new ProcessRegistry()
		let finish!: () => void
		const kill = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const process = registry.register(registration({ kill }))

		const first = registry.kill(process.id)
		const second = registry.kill(process.id)
		await Promise.resolve()
		finish()
		await Promise.all([first, second])

		expect(kill).toHaveBeenCalledOnce()
		expect(registry.get(process.id)?.status).toBe("running")
	})

	it("requests stops only for its conversation and counts only confirmed endings", async () => {
		const registry = new ProcessRegistry()
		const mine = registry.register(
			registration({
				kill: async () => {
					registry.markExited(mine.id, 130)
				},
			}),
		)
		const ended = registry.register(registration())
		registry.markExited(ended.id, 0)
		const child = registry.register(registration({ source: "child" }))
		const other = registry.register(registration({ conversationId: "conversation-2" }))

		expect(await registry.killAll("conversation-1")).toBe(1)

		expect(registry.get(mine.id)?.status).toBe("killed")
		expect(registry.get(child.id)).toMatchObject({ status: "running", stopRequested: true })
		expect(registry.get(ended.id)?.status).toBe("exited")
		expect(registry.get(other.id)?.status).toBe("running")

		expect(await registry.killAll(undefined, (process) => process.source === "child")).toBe(0)
		expect(await registry.killAll()).toBe(0)
		expect(registry.get(other.id)).toMatchObject({ status: "running", stopRequested: true })
	})

	it("forgets the oldest ended processes beyond fifty", () => {
		const registry = new ProcessRegistry()
		const running = registry.register(registration())
		for (let index = 0; index < 60; index++) {
			const process = registry.register(registration())
			registry.markExited(process.id, 0)
		}
		registry.register(registration())

		const ids = registry.list().map((process) => process.id)
		expect(ids).toContain(running.id)
		expect(ids).not.toContain("p2")
		expect(registry.list().filter((process) => process.status === "exited")).toHaveLength(50)
	})

	it("stops calling a disposed listener", () => {
		const registry = new ProcessRegistry()
		const listener = vi.fn()
		registry.onDidChange(listener).dispose()
		registry.register(registration())
		expect(listener).not.toHaveBeenCalled()
	})
})
