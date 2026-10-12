import { beforeEach, describe, expect, it } from "bun:test"
import { FakeClock } from "../../ci-watch/__tests__/fakes"
import { CiAutoRunner, type CiAutoRunnerDeps, type CiAutoStartResult } from "../ci-auto-runner"
import type { CiTargetView } from "../ci-board"
import { type CiSkills, noSkills } from "../ci-skills"
import { fingerprintOf } from "../ci-triage"
import type { CiBoardItem, CiLink, CiTriageResult } from "../types"
import { defaultActions } from "../types"
import { boardPr, boardTarget, SHA_A, SHA_B } from "./fake-board-provider"

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The slice of a board the runner reads, over plain data. */
class FakeBoard {
	views: CiTargetView[] = []
	links: Record<string, CiLink> = {}
	attempts = new Map<string, number>()
	triage = new Map<string, CiTriageResult>()
	skills: CiSkills = noSkills()
	blocked?: string
	touches = 0
	private listeners = new Set<() => void>()

	view = () => this.views
	runBlockedReason = () => this.blocked
	linkFor = (key: string) => this.links[key]
	onDidChange = (listener: () => void) => {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}
	autoAttempts = (key: string) => this.attempts.get(key) ?? 0
	recordAutoAttempt = async (keys: string[]) => {
		for (const key of keys) this.attempts.set(key, this.autoAttempts(key) + 1)
	}
	resetAutoAttempts = async (prefix: string) => {
		for (const key of [...this.attempts.keys()]) if (key.startsWith(prefix)) this.attempts.delete(key)
	}
	triageFor = (item: CiBoardItem) => {
		const result = this.triage.get(item.key)
		return result ? { result, stale: result.fingerprint !== fingerprintOf(item) } : undefined
	}
	skillsFor = () => this.skills
	touch = () => {
		this.touches++
	}
	changed() {
		for (const listener of this.listeners) listener()
	}
}

const ITEM_KEY = "octo/hello#12"

function item(overrides: Partial<CiBoardItem> = {}): CiBoardItem {
	return {
		key: ITEM_KEY,
		pr: boardPr(12, { sourceBranch: "feature" }),
		branch: "feature",
		headSha: SHA_A,
		mergeState: "clean",
		fork: false,
		pipelines: [{ name: "win_cpu", color: "red", status: "completed", result: "failure", runId: 101 }],
		...overrides,
	}
}

function smallDelta(of: CiBoardItem, overrides: Partial<CiTriageResult> = {}): CiTriageResult {
	return {
		fingerprint: fingerprintOf(of) as string,
		itemKey: of.key,
		status: "done",
		severity: "low",
		summary: "drift",
		pipelines: [{ name: "win_cpu", category: "small-test-delta", summary: "", steps: [] }],
		conflict: false,
		recommended: ["recalibrate"],
		source: "model",
		smallDeltaConfidence: 0.9,
		analyzedTs: 0,
		...overrides,
	}
}

describe("CiAutoRunner", () => {
	let board: FakeBoard
	let clock: FakeClock
	let started: string[]
	let startResult: CiAutoStartResult
	let active: Set<string>
	let freeSlots: number
	let notes: string[]
	let release: ((id: string) => void) | undefined
	let runner: CiAutoRunner

	const watch = (it: CiBoardItem, autoWatch = true) => {
		board.views = [{ target: boardTarget({ autoWatch, actions: defaultActions() }), items: [it], loading: false }]
	}

	const make = () => {
		const deps: CiAutoRunnerDeps = {
			board: board as unknown as CiAutoRunnerDeps["board"],
			start: async (_targetId, key, actionId) => {
				started.push(actionId)
				if (startResult === "started") {
					board.links[key] = {
						conversationId: `c${started.length}`,
						actionId,
						worktree: "/wt",
						headSha: SHA_A,
						startedTs: 0,
						auto: true,
					}
					active.add(`c${started.length}`)
				}
				return startResult
			},
			isActive: (id) => active.has(id),
			freeSlots: () => freeSlots,
			onBackgroundReleased: (listener) => {
				release = listener
				return () => undefined
			},
			notify: (_kind, message) => notes.push(message),
			settings: () => ({ maxAttemptsPerHead: 2, maxRunsPerItem: 3, maxConcurrent: 1 }),
			clock,
		}
		runner = new CiAutoRunner(deps)
		return runner
	}

	beforeEach(() => {
		board = new FakeBoard()
		clock = new FakeClock()
		started = []
		startResult = "started"
		active = new Set()
		freeSlots = 3
		notes = []
		release = undefined
	})

	it("does nothing for a target without auto-watch", async () => {
		watch(item({ mergeState: "conflicts" }), false)
		make().evaluate()
		await flush()
		expect(started).toEqual([])
		expect(runner.state(ITEM_KEY)).toBeUndefined()
	})

	it("fixes conflicts, once at a time, and reports it", async () => {
		watch(item({ mergeState: "conflicts" }))
		make().evaluate()
		await flush()
		expect(started).toEqual(["fix-conflicts"])
		expect(notes[0]).toContain("Auto-watch started Fix conflicts on PR #12 (attempt 1 of 2)")
		board.changed()
		await flush()
		expect(started).toHaveLength(1)
		expect(runner.state(ITEM_KEY)).toMatchObject({ status: "running", attempt: 1, maxAttempts: 2 })
	})

	it("recalibrates only on a confident model verdict, with every pipeline done and a skill to follow", async () => {
		const it1 = item()
		watch(it1)
		make()
		board.triage.set(ITEM_KEY, smallDelta(it1))
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.message).toContain("no recalibration skill")
		expect(started).toEqual([])

		board.skills = { ...noSkills(), recalibrate: [{ name: "recalibrate-unit-tests", path: "/s" }] }
		board.triage.set(ITEM_KEY, smallDelta(it1, { smallDeltaConfidence: 0.5 }))
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.status).toBe("needs_you")

		board.triage.set(ITEM_KEY, smallDelta(it1, { source: "heuristic" }))
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.message).toContain("Only rules classified")

		const running = item({ pipelines: [...it1.pipelines, { name: "linux", color: "yellow", status: "in_progress" }] })
		watch(running)
		board.triage.set(ITEM_KEY, smallDelta(running))
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.status).toBe("waiting_ci")

		watch(it1)
		board.triage.set(ITEM_KEY, smallDelta(it1))
		runner.evaluate()
		await flush()
		expect(started).toEqual(["recalibrate"])
	})

	it("leaves build failures and regressions to the user, and says so once", async () => {
		const it1 = item()
		watch(it1)
		make()
		board.triage.set(
			ITEM_KEY,
			smallDelta(it1, {
				pipelines: [{ name: "win_cpu", category: "build", summary: "", steps: [] }],
				smallDeltaConfidence: 0,
			}),
		)
		runner.evaluate()
		runner.evaluate()
		expect(runner.state(ITEM_KEY)).toMatchObject({ status: "needs_you" })
		expect(runner.state(ITEM_KEY)?.message).toContain("win_cpu has a build failure")
		expect(notes).toHaveLength(1)
		expect(started).toEqual([])
	})

	it("waits for the triage of the current state", async () => {
		watch(item())
		make().evaluate()
		expect(runner.state(ITEM_KEY)?.message).toBe("Waiting for the failure analysis.")
		board.triage.set(ITEM_KEY, { ...smallDelta(item()), fingerprint: "an older state" })
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.status).toBe("waiting_ci")
	})

	it("stops after the attempts per commit, and after the streak per pull request", async () => {
		watch(item({ mergeState: "conflicts" }))
		board.attempts.set(`${ITEM_KEY}|fix-conflicts|${SHA_A}`, 2)
		make().evaluate()
		expect(runner.state(ITEM_KEY)).toMatchObject({ status: "capped" })
		expect(notes[0]).toContain("already ran 2 times on this commit")

		watch(item({ mergeState: "conflicts", headSha: SHA_B }))
		board.attempts.set(`${ITEM_KEY}|fix-conflicts`, 3)
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.message).toContain("ran 3 times on this pull request")
		expect(started).toEqual([])
	})

	it("resets the counters once the pull request is green", async () => {
		board.attempts.set(`${ITEM_KEY}|fix-conflicts`, 3)
		watch(item({ pipelines: [{ name: "win_cpu", color: "green" }] }))
		make().evaluate()
		await flush()
		expect(board.attempts.size).toBe(0)
		expect(runner.state(ITEM_KEY)?.message).toBe("Watching: nothing to fix.")
	})

	it("keeps a background slot for the user, and retries when one frees up", async () => {
		freeSlots = 1
		watch(item({ mergeState: "conflicts" }))
		make().evaluate()
		expect(runner.state(ITEM_KEY)?.status).toBe("waiting_slot")
		expect(clock.pending).toBe(1)
		freeSlots = 2
		await clock.advance(30_000)
		await flush()
		expect(started).toEqual(["fix-conflicts"])
	})

	it("waits for CI after a run ends before trying again", async () => {
		watch(item({ mergeState: "conflicts" }))
		make().evaluate()
		await flush()
		active.clear()
		release?.("c1")
		expect(runner.state(ITEM_KEY)?.status).toBe("waiting_ci")
		await clock.advance(2 * 60_000 + 1)
		await flush()
		expect(started).toEqual(["fix-conflicts", "fix-conflicts"])
	})

	it("skips drafts, blocked items, and reports a start that fails", async () => {
		watch(item({ mergeState: "conflicts", pr: boardPr(12, { draft: true }) }))
		make().evaluate()
		expect(runner.state(ITEM_KEY)?.message).toContain("draft")

		board.blocked = "This pull request comes from a fork."
		watch(item({ mergeState: "conflicts" }))
		runner.evaluate()
		expect(runner.state(ITEM_KEY)?.message).toContain("fork")

		board.blocked = undefined
		startResult = { error: "feature is checked out in your own folder" }
		runner.evaluate()
		await flush()
		await flush()
		expect(runner.state(ITEM_KEY)).toMatchObject({ status: "needs_you" })
		expect(notes.at(-1)).toContain("could not start Fix conflicts")
	})
})
