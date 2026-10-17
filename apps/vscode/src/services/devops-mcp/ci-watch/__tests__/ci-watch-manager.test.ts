import { beforeEach, describe, expect, it } from "bun:test"
import { CiWatchManager, type CiWatchRequest, type CiWatchRestoreOptions } from "../ci-watch-manager"
import type { CiWatchTargetSpec } from "../ci-watch-source"
import type { CiWatchSource } from "../ci-watcher"
import { FakeClock, FakeHost, HEAD_A, HEAD_B, MemoryStore, MINUTE, run, SECOND, savedRecord } from "./fakes"

/** A source whose single run is already green, so a watch on it ends at its second poll. */
function greenSource(polls = { count: 0 }, head = HEAD_A): CiWatchSource {
	return {
		head: async () => head,
		runs: async () => {
			polls.count++
			return [run(1, "completed", "success", head)]
		},
		report: async () => {
			throw new Error("not used")
		},
	}
}

function request(label = "PR #7 (feature → main)", source = greenSource()): CiWatchRequest {
	return { source, label, providerKind: "GitHub", head: HEAD_A, until: "finished" }
}

/** Long enough for a watch on `greenSource` to end. */
const ONE_WATCH = 60 * SECOND

describe("CiWatchManager", () => {
	let clock: FakeClock
	let host: FakeHost
	let manager: CiWatchManager

	beforeEach(() => {
		clock = new FakeClock()
		host = new FakeHost()
		manager = new CiWatchManager(host, { clock, retryMs: 10 * SECOND, maxRetries: 2 })
	})

	it("shows what is being watched and sends one report when CI ends", async () => {
		expect(manager.watch("c1", request())).toBeUndefined()
		expect(manager.watching("c1")).toBe("PR #7 (feature → main)")
		expect(host.rows).toEqual([
			{
				conversationId: "c1",
				text: "**CI watcher** · Watching CI for PR #7 (feature → main) at `aaaaaaaa` until its runs finish. The result will arrive here as a message.",
			},
		])

		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].conversationId).toBe("c1")
		expect(host.delivered[0].prompt).toStartWith("[CI WATCHER] CI passed for PR #7 (feature → main) at aaaaaaaa: 1 passed.")
		expect(host.notifications).toHaveLength(0)
		expect(manager.watching("c1")).toBeUndefined()
		expect(clock.pending).toBe(0)
	})

	it("keeps one watch per conversation: a new one replaces the old one", async () => {
		const first = { count: 0 }
		manager.watch("c1", request("branch old", greenSource(first)))
		await clock.advance(30 * SECOND)
		expect(first.count).toBe(1)

		expect(manager.watch("c1", request("branch new"))).toBe("branch old")
		expect(manager.watching("c1")).toBe("branch new")
		expect(host.rows.at(-1)?.text).toContain("This replaces the watch on branch old.")

		await clock.advance(ONE_WATCH)
		expect(first.count).toBe(1)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toContain("CI passed for branch new")
	})

	it("keeps the watches of different conversations apart", async () => {
		manager.watch("c1", request("branch one"))
		manager.watch("c2", request("branch two"))
		await clock.advance(ONE_WATCH)
		expect(host.delivered.map((d) => d.conversationId).sort()).toEqual(["c1", "c2"])
	})

	it("cancels a watch without reporting", async () => {
		manager.watch("c1", request())
		expect(manager.cancel("c1")).toBe("PR #7 (feature → main)")
		expect(manager.cancel("c1")).toBeUndefined()
		expect(host.rows.at(-1)?.text).toBe("**CI watcher** · Stopped watching CI for PR #7 (feature → main).")
		expect(clock.pending).toBe(0)
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(0)
	})

	it("drops the watch of a deleted conversation", async () => {
		manager.watch("c1", request())
		manager.removeConversation("c1")
		expect(manager.watching("c1")).toBeUndefined()
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(0)
		expect(host.notifications).toHaveLength(0)
	})

	it("keeps the report of a conversation that is not loaded, notifies, and sends it when the conversation opens", async () => {
		host.delivery = "unavailable"
		manager.watch("c1", request())
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(0)
		expect(host.notifications).toEqual([
			{
				conversationId: "c1",
				message:
					"PlinyCode CI watcher: CI passed for PR #7 (feature → main) at aaaaaaaa: 1 passed. Open the conversation to send this result to the agent.",
			},
		])

		// Opening another conversation changes nothing.
		manager.conversationOpened("c2")
		expect(host.delivered).toHaveLength(0)

		host.delivery = "started"
		manager.conversationOpened("c1")
		await clock.advance(0)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toStartWith("[CI WATCHER] CI passed")
		expect(host.notifications).toHaveLength(1)

		// It is sent once.
		manager.conversationOpened("c1")
		await clock.advance(0)
		expect(host.delivered).toHaveLength(1)
	})

	it("does not send a kept report to a conversation that was deleted meanwhile", async () => {
		host.delivery = "unavailable"
		manager.watch("c1", request())
		await clock.advance(ONE_WATCH)
		manager.removeConversation("c1")
		host.delivery = "started"
		manager.conversationOpened("c1")
		await clock.advance(0)
		expect(host.delivered).toHaveLength(0)
	})

	it("tries again when the conversation is between states", async () => {
		let busy = 1
		host.delivery = () => (busy-- > 0 ? "busy" : "queued")
		manager.watch("c1", request())
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(0)
		await clock.advance(10 * SECOND)
		expect(host.delivered).toHaveLength(1)
		expect(host.notifications).toHaveLength(0)
	})

	it("falls back to a notification when the conversation stays busy", async () => {
		host.delivery = "busy"
		manager.watch("c1", request())
		await clock.advance(ONE_WATCH + 20 * SECOND)
		expect(host.delivered).toHaveLength(0)
		expect(host.notifications).toHaveLength(1)
		expect(clock.pending).toBe(0)
	})

	it("wakes a conversation at most five times in a row, then only notifies and says why", async () => {
		for (let i = 0; i < 5; i++) {
			manager.watch("c1", request())
			await clock.advance(ONE_WATCH)
		}
		expect(host.delivered).toHaveLength(5)
		expect(host.notifications).toHaveLength(0)

		manager.watch("c1", request())
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(5)
		expect(host.notifications).toHaveLength(1)
		expect(host.notifications[0].message).toStartWith(
			"PlinyCode CI watcher: CI passed for PR #7 (feature → main) at aaaaaaaa: 1 passed.",
		)
		expect(host.notifications[0].message).toContain(
			"has already woken this conversation 5 times in a row without a message from you",
		)
		expect(host.rows.at(-1)?.text).toContain("PlinyCode did not send this result to the agent")

		// Another conversation has its own count.
		manager.watch("c2", request())
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(6)
	})

	it("starts counting again after a message from the user", async () => {
		for (let i = 0; i < 5; i++) {
			manager.watch("c1", request())
			await clock.advance(ONE_WATCH)
		}
		manager.noteUserMessage("c1")
		manager.watch("c1", request())
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(6)
		expect(host.notifications).toHaveLength(0)
	})

	it("stops everything when cleared", async () => {
		manager.watch("c1", request())
		manager.watch("c2", request())
		manager.clear()
		expect(clock.pending).toBe(0)
		await clock.advance(ONE_WATCH)
		expect(host.delivered).toHaveLength(0)
	})
})

describe("CiWatchManager with a store", () => {
	const target = savedRecord().watch?.target as CiWatchTargetSpec
	let clock: FakeClock
	let host: FakeHost
	let store: MemoryStore
	let opened: { target: CiWatchTargetSpec; head: string }[]
	let deleted: Set<string>

	const manager = () => new CiWatchManager(host, { clock, retryMs: 10 * SECOND, maxRetries: 2, store })

	/** Restores with a source that is green at HEAD_B, as if CI finished during the reload. */
	const restoreOptions = (source = greenSource({ count: 0 }, HEAD_B)): CiWatchRestoreOptions => ({
		exists: async (id) => !deleted.has(id),
		openSource: async (spec, head) => {
			opened.push({ target: spec, head })
			return source
		},
	})

	beforeEach(() => {
		clock = new FakeClock()
		host = new FakeHost()
		store = new MemoryStore()
		opened = []
		deleted = new Set()
	})

	it("saves a watch with its target and state, and forgets it when it is cancelled", async () => {
		const watching = manager()
		watching.watch("c1", { ...request(), target })
		await clock.advance(0)
		expect(store.saved).toEqual([
			{
				conversationId: "c1",
				watch: {
					label: "PR #7 (feature → main)",
					providerKind: "GitHub",
					target,
					until: "finished",
					head: HEAD_A,
					headSince: 0,
					headMoves: [],
					startedAt: 0,
					deadline: 2 * 60 * MINUTE,
				},
			},
		])
		watching.cancel("c1")
		await clock.advance(0)
		expect(store.saved).toEqual([])
	})

	it("saves the new head when it moves", async () => {
		manager().watch("c1", { ...request("PR #7", greenSource({ count: 0 }, HEAD_B)), target })
		await clock.advance(30 * SECOND)
		expect(store.saved[0].watch?.head).toBe(HEAD_B)
		expect(store.saved[0].watch?.headSince).toBe(30 * SECOND)
		expect(store.saved[0].watch?.headMoves).toEqual([{ from: HEAD_A, to: HEAD_B }])
	})

	it("does not save a watch it could not rebuild", async () => {
		manager().watch("c1", request())
		await clock.advance(0)
		expect(store.saved).toEqual([])
	})

	it("resumes a saved watch from where it was, and reports when CI ends", async () => {
		store.saved = [savedRecord("c1")]
		await clock.advance(3 * MINUTE)
		const restored = manager()
		await restored.restore(restoreOptions())
		expect(restored.watching("c1")).toBe("PR #7 (feature → main)")
		// Nothing is shown in the chat for a resumed watch.
		expect(host.rows).toEqual([])
		// The source is built at the first poll, from the saved target and the last head seen.
		expect(opened).toEqual([])

		await clock.advance(ONE_WATCH)
		expect(opened).toEqual([{ target, head: HEAD_B }])
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toStartWith("[CI WATCHER] CI passed for PR #7 (feature → main) at bbbbbbbb")
		// The head move seen before the reload is still in the report.
		expect(host.delivered[0].prompt).toContain("The head moved while the watcher was waiting (aaaaaaaa → bbbbbbbb)")
		// The saved wake-up count carried on: 2 before the reload, 3 now.
		await clock.advance(0)
		expect(store.saved).toEqual([{ conversationId: "c1", wakeUps: 3 }])
	})

	it("keeps the saved watch's deadline", async () => {
		store.saved = [savedRecord("c1")]
		await clock.advance(2 * 60 * MINUTE - 45 * SECOND)
		const restored = manager()
		const pending: CiWatchSource = { ...greenSource(), runs: async () => [run(1, "in_progress")] }
		await restored.restore(restoreOptions(pending))
		await clock.advance(2 * MINUTE)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toContain("after 2 hours: 1 still running. The watch has ended.")
	})

	it("reports a watch whose source cannot be rebuilt after its polls fail", async () => {
		store.saved = [savedRecord("c1")]
		const restored = manager()
		await restored.restore({
			exists: async () => true,
			openSource: async () => {
				throw new Error("The checkout at /work/repo is gone")
			},
		})
		await clock.advance(10 * MINUTE)
		expect(host.delivered).toHaveLength(1)
		expect(host.delivered[0].prompt).toContain("The checkout at /work/repo is gone")
	})

	it("drops a watch that ran out of time during the reload, without a report", async () => {
		store.saved = [savedRecord("c1")]
		await clock.advance(3 * 60 * MINUTE)
		const restored = manager()
		await restored.restore(restoreOptions())
		expect(restored.watching("c1")).toBeUndefined()
		await clock.advance(10 * MINUTE)
		expect(host.delivered).toHaveLength(0)
		expect(host.notifications).toHaveLength(0)
		expect(clock.pending).toBe(0)
		expect(store.saved).toEqual([{ conversationId: "c1", wakeUps: 2 }])
	})

	it("drops everything about a conversation that was deleted", async () => {
		const held = { headline: "CI failed.", prompt: "[CI WATCHER] CI failed." }
		store.saved = [savedRecord("gone", { held }), savedRecord("kept")]
		deleted.add("gone")
		const restored = manager()
		await restored.restore(restoreOptions())
		expect(restored.watching("gone")).toBeUndefined()
		expect(restored.watching("kept")).toBe("PR #7 (feature → main)")
		restored.conversationOpened("gone")
		await clock.advance(0)
		expect(host.delivered).toHaveLength(0)
		expect(store.saved.map((r) => r.conversationId)).toEqual(["kept"])
	})

	it("sends a held report when its conversation is opened after a restore", async () => {
		const held = { headline: "CI failed.", prompt: "[CI WATCHER] CI failed for PR #7." }
		store.saved = [{ conversationId: "c1", held }]
		const restored = manager()
		await restored.restore(restoreOptions())
		expect(host.delivered).toHaveLength(0)
		restored.conversationOpened("c1")
		await clock.advance(0)
		expect(host.delivered).toEqual([{ conversationId: "c1", prompt: held.prompt }])
		expect(store.saved).toEqual([{ conversationId: "c1", wakeUps: 1 }])
	})

	it("saves a report that is still waiting for a busy conversation as held", async () => {
		host.delivery = "busy"
		manager().watch("c1", { ...request(), target })
		await clock.advance(ONE_WATCH)
		expect(store.saved).toEqual([
			{ conversationId: "c1", held: { headline: expect.any(String), prompt: expect.stringContaining("CI passed") } },
		])
	})

	it("keeps the saved watches when disposed, and forgets them when cleared", async () => {
		const first = manager()
		first.watch("c1", { ...request(), target })
		await clock.advance(0)
		first.dispose()
		expect(clock.pending).toBe(0)
		expect(store.saved).toHaveLength(1)

		const second = manager()
		await second.restore(restoreOptions())
		expect(second.watching("c1")).toBe("PR #7 (feature → main)")
		second.clear()
		await clock.advance(0)
		expect(store.saved).toEqual([])
	})

	it("lets a watch started while restoring win over the saved one", async () => {
		store.saved = [savedRecord("c1")]
		const restored = manager()
		let release = () => {}
		const done = restored.restore({
			...restoreOptions(),
			exists: () =>
				new Promise<boolean>((resolve) => {
					release = () => resolve(true)
				}),
		})
		await clock.advance(0)
		restored.watch("c1", { ...request("branch new"), target })
		release()
		await done
		expect(restored.watching("c1")).toBe("branch new")
		await clock.advance(0)
		expect(store.saved.map((r) => r.watch?.label)).toEqual(["branch new"])
	})
})
