import { describe, expect, it } from "bun:test"
import { FakeClock, MINUTE } from "../../ci-watch/__tests__/fakes"
import { CiBoardPoller, type CiBoardTimings } from "../ci-board-poller"
import type { CiTarget, CiTransition } from "../types"
import { boardPr, boardRun, boardTarget, FakeBoardProvider, SHA_A, SHA_B } from "./fake-board-provider"

const TIMINGS: Partial<CiBoardTimings> = { pollMs: MINUTE, hiddenPollMs: 3 * MINUTE, fullRefreshMs: 10 * MINUTE }

function setup(provider = new FakeBoardProvider(), targets: CiTarget[] = [boardTarget()]) {
	const clock = new FakeClock()
	const updates: string[] = []
	const transitions: CiTransition[] = []
	const providers = new Map<string, FakeBoardProvider>()
	const poller = new CiBoardPoller({
		providerFor: (t) => providers.get(t.id) ?? provider,
		maxPrsPerRepo: () => 30,
		onUpdate: (id) => updates.push(id),
		onTransition: (t) => transitions.push(t),
		clock,
		timings: TIMINGS,
	})
	return { clock, poller, provider, providers, updates, transitions, start: () => poller.setTargets(targets) }
}

describe("CiBoardPoller", () => {
	it("lists the open PRs and shows each one's pipelines and merge state", async () => {
		const { provider, poller, clock, start, updates } = setup()
		provider.prs = [boardPr(1), boardPr(2, { author: "someone" }), boardPr(3, { headSha: SHA_B })]
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "failure"), boardRun(11, "linux", "completed", "success")])
		provider.mergeStates.set(3, "conflicts")
		start()
		await clock.advance(0)

		const { items, loading, error } = poller.snapshot("t1")
		expect([loading, error]).toEqual([false, undefined])
		// `mine` leaves out PR 2.
		expect(items.map((i) => [i.key, i.mergeState, i.pipelines.map((p) => `${p.name}:${p.color}`).join(",")])).toEqual([
			["github|github.com|octo/hello#1", "clean", "linux:green,win:red"],
			["github|github.com|octo/hello#3", "conflicts", ""],
		])
		expect(updates).toEqual(["t1"])
	})

	it("only lists on later cycles while nothing can have changed", async () => {
		const { provider, clock, start, poller } = setup()
		provider.prs = [boardPr(1)]
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "success")])
		poller.setVisible(true)
		start()
		await clock.advance(0)
		const after = { ...provider.calls }
		await clock.advance(5 * MINUTE)
		expect(provider.calls.listOpenPrs - after.listOpenPrs).toBe(5)
		expect([provider.calls.getPr, provider.calls.listRuns]).toEqual([after.getPr, after.listRuns])
		// The full refresh catches re-runs on an unchanged commit.
		await clock.advance(5 * MINUTE)
		expect(provider.calls.listRuns).toBe(after.listRuns + 1)
	})

	it("keeps fetching runs that are still going, and reports a pipeline turning red", async () => {
		const { provider, clock, start, poller, transitions } = setup()
		provider.prs = [boardPr(1)]
		provider.runs.set(SHA_A, [boardRun(10, "win", "in_progress")])
		poller.setVisible(true)
		start()
		await clock.advance(0)
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "failure")])
		await clock.advance(MINUTE)
		expect(poller.snapshot("t1").items[0].pipelines[0].color).toBe("red")
		expect(transitions).toEqual([
			{ targetId: "t1", itemKey: "github|github.com|octo/hello#1", kind: "failed", pipelines: ["win"], headSha: SHA_A },
		])
	})

	it("fetches a PR again when its head moves, keeping missing pipelines as grey", async () => {
		const { provider, clock, start, poller } = setup()
		provider.prs = [boardPr(1)]
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "success")])
		poller.setVisible(true)
		start()
		await clock.advance(0)
		provider.prs = [boardPr(1, { headSha: SHA_B })]
		await clock.advance(MINUTE)
		const [item] = poller.snapshot("t1").items
		expect([item.headSha, item.pipelines.map((p) => p.color)]).toEqual([SHA_B, ["grey"]])
	})

	it("polls every pollMs while visible and every hiddenPollMs otherwise", async () => {
		const { provider, clock, start, poller } = setup()
		provider.prs = [boardPr(1)]
		start()
		await clock.advance(0)
		await clock.advance(2 * MINUTE)
		expect(provider.calls.listOpenPrs).toBe(1)
		await clock.advance(MINUTE)
		expect(provider.calls.listOpenPrs).toBe(2)
		poller.setVisible(true) // last cycle was just now: no extra one
		await clock.advance(MINUTE)
		expect(provider.calls.listOpenPrs).toBe(3)
	})

	it("reports one target's failure without stopping the others", async () => {
		const broken = new FakeBoardProvider()
		broken.failList = true
		const { provider, providers, clock, start, poller } = setup(new FakeBoardProvider(), [
			boardTarget({ id: "bad" }),
			boardTarget({ id: "good" }),
		])
		providers.set("bad", broken)
		provider.prs = [boardPr(1)]
		start()
		await clock.advance(0)
		expect(poller.snapshot("bad").error).toContain("HTTP 502")
		expect(poller.snapshot("good").items).toHaveLength(1)
	})

	it("watches a branch without a PR through its head on the server", async () => {
		const provider = new FakeBoardProvider("Azure DevOps")
		provider.heads.set("feature", SHA_A)
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "success")])
		const { clock, start, poller } = setup(provider, [
			boardTarget({
				kind: "branch",
				branch: "feature",
				prFilter: undefined,
				provider: "ado",
				remoteUrl: "https://dev.azure.com/acme/P/_git/r",
			}),
		])
		start()
		await clock.advance(0)
		const [item] = poller.snapshot("t1").items
		expect([item.key, item.headSha, item.pr]).toEqual(["ado|dev.azure.com|acme/P/r@feature", SHA_A, undefined])
		expect(item.pipelines[0].color).toBe("green")
	})

	it("stays within a small request budget for 20 idle PRs over an hour", async () => {
		const { provider, clock, start, poller } = setup()
		provider.prs = Array.from({ length: 20 }, (_, i) => boardPr(i + 1))
		provider.runs.set(SHA_A, [boardRun(10, "win", "completed", "success")])
		poller.setVisible(true)
		start()
		await poller.whenIdle()
		for (let minute = 0; minute < 60; minute++) {
			await clock.advance(MINUTE)
			await poller.whenIdle()
		}
		// 61 listings, plus each PR's merge state and runs on the first cycle and every 10 minutes.
		expect(provider.total).toBe(61 + 7 * 20 * 2)
		expect(provider.total).toBeLessThan(400)
	})

	it("slows down and looks only at new commits while the rate limit is low", async () => {
		const { provider, clock, start, poller } = setup()
		provider.prs = [boardPr(1)]
		provider.runs.set(SHA_A, [boardRun(10, "win", "in_progress")])
		poller.setVisible(true)
		start()
		await clock.advance(0)
		provider.rateLimitRemaining = 100
		await clock.advance(MINUTE) // this cycle sees the low limit
		const runs = provider.calls.listRuns
		expect(poller.rateLimited).toBe(true)
		await clock.advance(3 * MINUTE)
		expect(provider.calls.listOpenPrs).toBe(2)
		await clock.advance(MINUTE)
		expect(provider.calls.listOpenPrs).toBe(3)
		expect(provider.calls.listRuns).toBe(runs)
	})

	it("starts a target over when its selection changes, and forgets removed ones", async () => {
		const { provider, clock, poller } = setup()
		provider.prs = [boardPr(1), boardPr(2, { author: "someone" })]
		poller.setTargets([boardTarget()])
		await clock.advance(0)
		expect(poller.snapshot("t1").items).toHaveLength(1)
		poller.setTargets([boardTarget({ prFilter: "all" })])
		await clock.advance(0)
		expect(poller.snapshot("t1").items).toHaveLength(2)
		poller.setTargets([])
		expect(poller.snapshot("t1")).toEqual({ items: [], loading: false })
		expect(clock.pending).toBe(0)
	})
})
