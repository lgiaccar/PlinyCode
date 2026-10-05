import type { TurnPhase } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getCiWatchManager } from "@/services/devops-mcp/builtin-mcp-registry"
import type { CiWatchRequest } from "@/services/devops-mcp/ci-watch/ci-watch-manager"
import type { ActiveSession } from "./cline-session-factory"
import { SdkCiWatchCoordinator } from "./sdk-ci-watch-coordinator"

type SdkCiWatchCoordinatorOptions = ConstructorParameters<typeof SdkCiWatchCoordinator>[0]

const REPORT = "[CI WATCHER] CI failed for PR #7 (feature → main) at aaaaaaaa: 1 failed."

function session(sessionId: string, isRunning: boolean): ActiveSession {
	return { sessionId, isRunning, unsubscribe: () => {}, sdkHost: {} } as unknown as ActiveSession
}

/** A watch whose single run is already green: it ends at its second poll, 60 s in. */
function greenWatch(): CiWatchRequest {
	return {
		label: "PR #7 (feature → main)",
		providerKind: "GitHub",
		head: "a".repeat(40),
		until: "finished",
		source: {
			head: async () => "a".repeat(40),
			runs: async () => [
				{
					id: 1,
					name: "ci",
					status: "completed",
					result: "success",
					branch: "feature",
					commit: "a".repeat(40),
					url: "u",
				},
			],
			report: async () => {
				throw new Error("not used")
			},
		},
	}
}

describe("SdkCiWatchCoordinator", () => {
	let displayed: string | undefined
	let active: ActiveSession | undefined
	let phase: TurnPhase
	let pendingInteraction: boolean
	let backgroundTasks: Set<string>
	let options: {
		[K in "queueToActiveSession" | "queueToBackgroundTask" | "startTurn" | "emitRow" | "notify" | "openTask"]: ReturnType<
			typeof vi.fn<SdkCiWatchCoordinatorOptions[K]>
		>
	}
	let coordinator: SdkCiWatchCoordinator

	beforeEach(() => {
		vi.useFakeTimers()
		displayed = "c1"
		active = session("c1", false)
		phase = "awaiting_followup"
		pendingInteraction = false
		backgroundTasks = new Set()
		options = {
			queueToActiveSession: vi.fn<SdkCiWatchCoordinatorOptions["queueToActiveSession"]>(),
			queueToBackgroundTask: vi.fn<SdkCiWatchCoordinatorOptions["queueToBackgroundTask"]>((id) => backgroundTasks.has(id)),
			startTurn: vi.fn<SdkCiWatchCoordinatorOptions["startTurn"]>(async () => {}),
			emitRow: vi.fn<SdkCiWatchCoordinatorOptions["emitRow"]>(),
			notify: vi.fn<SdkCiWatchCoordinatorOptions["notify"]>(),
			openTask: vi.fn<SdkCiWatchCoordinatorOptions["openTask"]>(),
		}
		coordinator = new SdkCiWatchCoordinator({
			getDisplayedTaskId: () => displayed,
			getActiveSession: () => active,
			getTurnPhase: () => phase,
			hasPendingInteraction: () => pendingInteraction,
			...options,
		})
	})

	afterEach(() => {
		coordinator.dispose()
		vi.useRealTimers()
	})

	it("offers its manager to the watch_ci tool until it is disposed", () => {
		expect(getCiWatchManager()).toBe(coordinator.manager)
		coordinator.dispose()
		expect(getCiWatchManager()).toBeUndefined()
	})

	describe("deliver", () => {
		it("starts a turn when the conversation is on screen and idle", async () => {
			for (const idle of ["awaiting_followup", "completed", "resumable", "error", "idle"] as const) {
				phase = idle
				expect(await coordinator.deliver("c1", REPORT)).toBe("started")
			}
			expect(options.startTurn).toHaveBeenCalledTimes(5)
			expect(options.startTurn).toHaveBeenLastCalledWith(REPORT)
			expect(options.queueToActiveSession).not.toHaveBeenCalled()
		})

		it("starts a turn when the conversation is on screen without a live session", async () => {
			active = undefined
			phase = "completed"
			expect(await coordinator.deliver("c1", REPORT)).toBe("started")
			expect(options.startTurn).toHaveBeenCalledWith(REPORT)
		})

		it("queues behind the running turn", async () => {
			active = session("c1", true)
			phase = "streaming"
			expect(await coordinator.deliver("c1", REPORT)).toBe("queued")
			expect(options.queueToActiveSession).toHaveBeenCalledWith(active, REPORT)
			expect(options.startTurn).not.toHaveBeenCalled()
		})

		it("queues rather than answer a pending approval or question", async () => {
			// ask_question leaves the phase at awaiting_followup, like a finished turn.
			pendingInteraction = true
			expect(await coordinator.deliver("c1", REPORT)).toBe("queued")
			phase = "awaiting_approval"
			pendingInteraction = false
			expect(await coordinator.deliver("c1", REPORT)).toBe("queued")
			expect(options.queueToActiveSession).toHaveBeenCalledTimes(2)
			expect(options.startTurn).not.toHaveBeenCalled()
		})

		it("queues on a task that runs in the background", async () => {
			displayed = "other"
			backgroundTasks.add("c1")
			expect(await coordinator.deliver("c1", REPORT)).toBe("queued")
			expect(options.queueToBackgroundTask).toHaveBeenCalledWith("c1", REPORT)
			expect(options.startTurn).not.toHaveBeenCalled()
			expect(options.queueToActiveSession).not.toHaveBeenCalled()
		})

		it("does not deliver to a conversation that is not loaded", async () => {
			displayed = "other"
			expect(await coordinator.deliver("c1", REPORT)).toBe("unavailable")
			displayed = undefined
			expect(await coordinator.deliver("c1", REPORT)).toBe("unavailable")
			expect(options.startTurn).not.toHaveBeenCalled()
		})

		it("asks to be called again while the conversation's session is being started or replaced", async () => {
			active = undefined
			phase = "streaming"
			expect(await coordinator.deliver("c1", REPORT)).toBe("busy")
			active = session("stale", false)
			phase = "completed"
			expect(await coordinator.deliver("c1", REPORT)).toBe("busy")
			expect(options.startTurn).not.toHaveBeenCalled()
		})
	})

	it("shows rows only in the conversation they belong to", () => {
		coordinator.showRow("c1", "row")
		coordinator.showRow("c2", "row")
		expect(options.emitRow).toHaveBeenCalledTimes(1)
	})

	it("sends the report of a finished watch into the idle conversation", async () => {
		coordinator.manager.watch("c1", greenWatch())
		expect(options.emitRow).toHaveBeenCalledWith(expect.stringContaining("Watching CI for PR #7 (feature → main)"))
		await vi.advanceTimersByTimeAsync(60_000)
		expect(options.startTurn).toHaveBeenCalledTimes(1)
		expect(options.startTurn.mock.calls[0][0]).toMatch(/^\[CI WATCHER\] CI passed for PR #7/)
		expect(options.notify).not.toHaveBeenCalled()
	})

	it("notifies with an Open action for a conversation that is not loaded, and delivers once it is opened", async () => {
		coordinator.manager.watch("c1", greenWatch())
		displayed = "other"
		active = session("other", false)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(options.startTurn).not.toHaveBeenCalled()
		expect(options.notify).toHaveBeenCalledTimes(1)
		expect(options.notify.mock.calls[0][0]).toContain("Open the conversation to send this result to the agent.")

		// The notification's action opens the conversation...
		options.notify.mock.calls[0][1]()
		expect(options.openTask).toHaveBeenCalledWith("c1")
		// ...and the controller tells the manager once it is on screen.
		displayed = "c1"
		active = undefined
		phase = "completed"
		coordinator.manager.conversationOpened("c1")
		await vi.advanceTimersByTimeAsync(0)
		expect(options.startTurn).toHaveBeenCalledTimes(1)
		expect(options.notify).toHaveBeenCalledTimes(1)
	})

	it("stops waking the conversation after five reports in a row, until the user writes", async () => {
		const finishWatch = async () => {
			coordinator.manager.watch("c1", greenWatch())
			await vi.advanceTimersByTimeAsync(60_000)
		}
		for (let i = 0; i < 5; i++) {
			await finishWatch()
			// Each report reaches the controller as a follow-up; that must not count as the user writing.
			coordinator.noteFollowUp(options.startTurn.mock.calls.at(-1)?.[0])
		}
		expect(options.startTurn).toHaveBeenCalledTimes(5)

		await finishWatch()
		expect(options.startTurn).toHaveBeenCalledTimes(5)
		expect(options.notify).toHaveBeenCalledTimes(1)
		expect(options.notify.mock.calls[0][0]).toContain("5 times in a row without a message from you")

		// Clicking Resume sends no content; a typed message does.
		coordinator.noteFollowUp(undefined)
		await finishWatch()
		expect(options.startTurn).toHaveBeenCalledTimes(5)
		coordinator.noteFollowUp("try again")
		await finishWatch()
		expect(options.startTurn).toHaveBeenCalledTimes(6)
	})
})
