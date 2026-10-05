import { beforeEach, describe, expect, it } from "bun:test"
import { buildCiWatchMessage } from "../ci-watch-report"
import { createCiWatchSource, resolveCiWatchTarget } from "../ci-watch-source"
import { CiWatcher, type CiWatchOutcome, type CiWatchUntil, DEFAULT_CI_WATCH_TIMINGS } from "../ci-watcher"
import { FakeClock, FakeProvider, fakeContext, HEAD_A, HEAD_B, MINUTE, run, SECOND } from "./fakes"

describe("CiWatcher", () => {
	let clock: FakeClock
	let provider: FakeProvider
	let outcomes: CiWatchOutcome[]

	beforeEach(() => {
		clock = new FakeClock()
		provider = new FakeProvider()
		outcomes = []
	})

	async function watch(until: CiWatchUntil = "finished"): Promise<CiWatcher> {
		const repo = { ctx: fakeContext(), provider }
		const target = await resolveCiWatchTarget(repo, {})
		return new CiWatcher({
			source: createCiWatchSource(repo, target),
			head: target.head,
			until,
			clock,
			onOutcome: (outcome) => outcomes.push(outcome),
		})
	}

	const message = (outcome: CiWatchOutcome) =>
		buildCiWatchMessage("PR #7 (feature → main)", "GitHub", outcome, DEFAULT_CI_WATCH_TIMINGS)

	it("reports a green result once every run has finished, and then stops polling", async () => {
		provider.runs = [run(1, "in_progress"), run(2, "queued")]
		await watch()
		await clock.advance(30 * SECOND)
		expect(provider.polls).toBe(1)
		expect(outcomes).toHaveLength(0)

		provider.runs = [run(1, "completed", "success"), run(2, "completed", "success")]
		await clock.advance(30 * SECOND)
		// Complete for the first time: one more poll confirms that no other run was still to appear.
		expect(outcomes).toHaveLength(0)
		await clock.advance(30 * SECOND)

		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toMatchObject({ kind: "finished", head: HEAD_A, headMoves: [], reports: [] })
		const { headline, prompt } = message(outcomes[0])
		expect(headline).toBe("CI passed for PR #7 (feature → main) at aaaaaaaa: 2 passed.")
		expect(prompt.startsWith("[CI WATCHER] CI passed for PR #7")).toBe(true)
		expect(prompt).toContain("the user did not type it")
		expect(prompt).not.toContain("Investigate")
		expect(clock.pending).toBe(0)
		await clock.advance(10 * MINUTE)
		expect(provider.polls).toBe(3)
	})

	it("waits for a run that appears after the first ones finished", async () => {
		provider.runs = [run(1, "completed", "success")]
		await watch()
		await clock.advance(30 * SECOND)
		provider.runs = [run(1, "completed", "success"), run(2, "in_progress")]
		await clock.advance(60 * SECOND)
		expect(outcomes).toHaveLength(0)
		provider.runs = [run(1, "completed", "success"), run(2, "completed", "success")]
		await clock.advance(60 * SECOND)
		expect(outcomes.map((o) => o.kind)).toEqual(["finished"])
		expect(outcomes[0].runs).toHaveLength(2)
	})

	it("reports a red result with the failed jobs, steps and log lines", async () => {
		provider.runs = [run(1, "completed", "failure"), run(2, "completed", "success")]
		provider.reports.set(1, {
			run: provider.runs[0],
			jobs: [{ name: "unit (ubuntu)", status: "completed", result: "failure" }],
			failures: [
				{
					job: "unit (ubuntu)",
					step: "Run tests",
					errors: ["Process completed with exit code 1."],
					logTail: "expected 2 to be 3\n##[error]Process completed with exit code 1.",
				},
			],
		})
		await watch()
		await clock.advance(60 * SECOND)

		expect(outcomes).toHaveLength(1)
		expect(outcomes[0].kind).toBe("finished")
		const { headline, prompt } = message(outcomes[0])
		expect(headline).toBe("CI failed for PR #7 (feature → main) at aaaaaaaa: 1 failed, 1 passed.")
		expect(prompt).toContain("- failure: [workflow-1](https://github.com/octo/hello/actions/runs/1) (run id 1)")
		expect(prompt).toContain("- workflow-1 › unit (ubuntu) › Run tests")
		expect(prompt).toContain("- Process completed with exit code 1.")
		expect(prompt).toContain("expected 2 to be 3")
		expect(prompt.trimEnd().split("\n").at(-1)).toStartWith("Investigate the failure, and fix it if your change caused it")
	})

	it("still reports a failure whose details cannot be read", async () => {
		provider.runs = [run(1, "completed", "failure")]
		await watch()
		await clock.advance(60 * SECOND)
		expect(outcomes[0]).toMatchObject({ kind: "finished", reports: [] })
		expect(message(outcomes[0]).prompt).toContain("- workflow-1: not read; call pipeline_report with run id 1")
	})

	it("reports the first failure without waiting for the other runs when asked to", async () => {
		provider.runs = [run(1, "completed", "failure"), run(2, "in_progress")]
		const finished = await watch("finished")
		await clock.advance(5 * MINUTE)
		expect(outcomes).toHaveLength(0)
		finished.cancel()

		await watch("first_failure")
		await clock.advance(30 * SECOND)
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0].kind).toBe("first_failure")
		const { headline, prompt } = message(outcomes[0])
		expect(headline).toBe("CI has a failed run for PR #7 (feature → main) at aaaaaaaa: 1 failed, 1 still running.")
		expect(prompt).toContain("call watch_ci again after you push a fix")
	})

	it("follows the pull request to a new head commit and says so", async () => {
		provider.runs = [run(1, "in_progress")]
		await watch()
		await clock.advance(30 * SECOND)

		// A push: the old commit's run is cancelled, and the new commit gets its own.
		if (provider.pr) provider.pr.headSha = HEAD_B
		provider.runs = [run(1, "completed", "cancelled"), run(2, "in_progress", undefined, HEAD_B)]
		await clock.advance(60 * SECOND)
		expect(outcomes).toHaveLength(0)

		provider.runs = [run(1, "completed", "cancelled"), run(2, "completed", "success", HEAD_B)]
		await clock.advance(60 * SECOND)
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toMatchObject({ kind: "finished", head: HEAD_B, headMoves: [{ from: HEAD_A, to: HEAD_B }] })
		expect(outcomes[0].runs.map((r) => r.id)).toEqual([2])
		const { headline, prompt } = message(outcomes[0])
		expect(headline).toBe("CI passed for PR #7 (feature → main) at bbbbbbbb: 1 passed.")
		expect(prompt).toContain(
			"The head moved while the watcher was waiting (aaaaaaaa → bbbbbbbb), so this result is for bbbbbbbb.",
		)
	})

	it("reports that no CI run started when none appears within 10 minutes", async () => {
		// A run for another commit of the branch is not this commit's CI.
		provider.runs = [run(9, "completed", "success", HEAD_B)]
		await watch()
		await clock.advance(10 * MINUTE - SECOND)
		expect(outcomes).toHaveLength(0)
		await clock.advance(SECOND)
		expect(outcomes.map((o) => o.kind)).toEqual(["no_runs"])
		expect(message(outcomes[0]).headline).toBe("No CI run started for PR #7 (feature → main) at aaaaaaaa within 10 minutes.")
		expect(clock.pending).toBe(0)
	})

	it("gives a new head its own 10 minutes to get a run", async () => {
		await watch()
		await clock.advance(9 * MINUTE)
		if (provider.pr) provider.pr.headSha = HEAD_B
		await clock.advance(9 * MINUTE)
		expect(outcomes).toHaveLength(0)
		await clock.advance(2 * MINUTE)
		expect(outcomes).toMatchObject([{ kind: "no_runs", head: HEAD_B }])
	})

	it("retries after API errors and gives up after five failed polls in a row", async () => {
		provider.runs = [run(1, "in_progress")]
		provider.failNext = 4
		await watch()
		await clock.advance(5 * 30 * SECOND)
		// Four failures, then a poll that worked: the count starts again.
		expect(provider.polls).toBe(5)
		expect(outcomes).toHaveLength(0)

		provider.failNext = 5
		await clock.advance(4 * 30 * SECOND)
		expect(outcomes).toHaveLength(0)
		await clock.advance(30 * SECOND)
		expect(outcomes).toHaveLength(1)
		expect(outcomes[0]).toMatchObject({ kind: "api_errors", error: "GET /actions/runs -> HTTP 502: Bad Gateway" })
		const { headline, prompt } = message(outcomes[0])
		expect(headline).toBe("The CI watcher could not reach GitHub for PR #7 (feature → main) at aaaaaaaa and stopped.")
		expect(prompt).toContain("Last error: GET /actions/runs -> HTTP 502: Bad Gateway")
		expect(clock.pending).toBe(0)
	})

	it("polls every 30 s for 10 minutes, then every 60 s, and stops after 2 hours", async () => {
		provider.runs = [run(1, "in_progress")]
		await watch()
		await clock.advance(10 * MINUTE)
		expect(provider.polls).toBe(20)
		await clock.advance(10 * MINUTE)
		expect(provider.polls).toBe(30)
		await clock.advance(100 * MINUTE - SECOND)
		expect(outcomes).toHaveLength(0)
		await clock.advance(SECOND)
		expect(provider.polls).toBe(130)
		expect(outcomes.map((o) => o.kind)).toEqual(["timeout"])
		expect(message(outcomes[0]).headline).toBe(
			"CI is still running for PR #7 (feature → main) at aaaaaaaa after 2 hours: 1 still running. The watch has ended.",
		)
		expect(clock.pending).toBe(0)
	})

	it("stops polling and reports nothing once cancelled", async () => {
		provider.runs = [run(1, "completed", "success")]
		const watcher = await watch()
		await clock.advance(30 * SECOND)
		watcher.cancel()
		expect(clock.pending).toBe(0)
		await clock.advance(10 * MINUTE)
		expect(provider.polls).toBe(1)
		expect(outcomes).toHaveLength(0)
	})
})
