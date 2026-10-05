import { beforeEach, describe, expect, it } from "bun:test"
import { CiWatchManager, type CiWatchRequest } from "../ci-watch-manager"
import type { CiWatchSource } from "../ci-watcher"
import { FakeClock, FakeHost, HEAD_A, run, SECOND } from "./fakes"

/** A source whose single run is already green, so a watch on it ends at its second poll. */
function greenSource(polls = { count: 0 }): CiWatchSource {
	return {
		head: async () => HEAD_A,
		runs: async () => {
			polls.count++
			return [run(1, "completed", "success")]
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
