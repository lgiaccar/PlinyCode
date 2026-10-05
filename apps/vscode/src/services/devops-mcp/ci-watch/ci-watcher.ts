/**
 * One CI watch: polls the runs of a pull request's or branch's head commit
 * until they finish, and reports the outcome once. It runs in the extension
 * host on plain timers, so no model turn stays open while CI runs.
 */
import type { PipelineRun, RunReport } from "../server/providers/types"

export type CiWatchUntil = "finished" | "first_failure"

/** What a watch polls. `createCiWatchSource` builds one from a provider. */
export interface CiWatchSource {
	/** The commit the watched pull request or branch points at now. */
	head(): Promise<string>
	/** The CI runs for that commit. */
	runs(head: string): Promise<PipelineRun[]>
	report(runId: number): Promise<RunReport>
}

interface CiHeadMove {
	from: string
	to: string
}

interface CiWatchOutcomeBase {
	/** The commit the outcome is about: the last head seen. */
	head: string
	/** Every time the head changed while watching, oldest first. */
	headMoves: CiHeadMove[]
	runs: PipelineRun[]
}

export type CiWatchOutcome = CiWatchOutcomeBase &
	(
		| {
				kind: "finished" | "first_failure"
				/** Reports of the failed runs, at most `maxReports` of them. */
				reports: RunReport[]
		  }
		| { kind: "no_runs" | "timeout" }
		| { kind: "api_errors"; error: string }
	)

export interface CiWatchTimings {
	pollMs: number
	/** Polling interval once the watch is older than `slowAfterMs`. */
	slowPollMs: number
	slowAfterMs: number
	/** How long a head commit may stay without any run before the watch gives up. */
	noRunsMs: number
	maxMs: number
	/** Polls that may fail in a row before the watch gives up. */
	maxFailures: number
	/** Failed runs whose jobs and logs are fetched for the report. */
	maxReports: number
}

export const DEFAULT_CI_WATCH_TIMINGS: CiWatchTimings = {
	pollMs: 30_000,
	slowPollMs: 60_000,
	slowAfterMs: 10 * 60_000,
	noRunsMs: 10 * 60_000,
	maxMs: 2 * 60 * 60_000,
	maxFailures: 5,
	maxReports: 3,
}

/** The timer functions a watch uses (tests pass a fake clock). */
export interface CiWatchClock {
	now(): number
	setTimeout(callback: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export const SYSTEM_CLOCK: CiWatchClock = {
	now: () => Date.now(),
	setTimeout: (callback, ms) => setTimeout(callback, ms),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface CiWatcherOptions {
	source: CiWatchSource
	/** The head commit seen when the watch was registered. */
	head: string
	until: CiWatchUntil
	onOutcome: (outcome: CiWatchOutcome) => void
	clock?: CiWatchClock
	timings?: CiWatchTimings
}

const isFailure = (run: PipelineRun) => run.status === "completed" && run.result === "failure"

export class CiWatcher {
	private readonly source: CiWatchSource
	private readonly until: CiWatchUntil
	private readonly onOutcome: (outcome: CiWatchOutcome) => void
	private readonly clock: CiWatchClock
	private readonly timings: CiWatchTimings
	private readonly startedAt: number
	private currentHead: string
	/** When the current head was first seen; the no-run deadline counts from here. */
	private headSince: number
	private readonly headMoves: CiHeadMove[] = []
	private runs: PipelineRun[] = []
	/** The set of runs that were all complete at the previous poll. */
	private settledRuns?: string
	private failedPolls = 0
	private timer?: unknown
	private done = false

	constructor(options: CiWatcherOptions) {
		this.source = options.source
		this.until = options.until
		this.onOutcome = options.onOutcome
		this.clock = options.clock ?? SYSTEM_CLOCK
		this.timings = options.timings ?? DEFAULT_CI_WATCH_TIMINGS
		this.currentHead = options.head
		this.startedAt = this.clock.now()
		this.headSince = this.startedAt
		this.schedule()
	}

	get head(): string {
		return this.currentHead
	}

	/** Stops the watch without reporting. */
	cancel(): void {
		this.done = true
		this.clock.clearTimeout(this.timer)
	}

	private schedule(): void {
		const age = this.clock.now() - this.startedAt
		const delay = age < this.timings.slowAfterMs ? this.timings.pollMs : this.timings.slowPollMs
		this.timer = this.clock.setTimeout(() => void this.poll(), delay)
	}

	private async poll(): Promise<void> {
		if (this.done) {
			return
		}
		try {
			const head = await this.source.head()
			if (this.done) {
				return
			}
			if (head !== this.currentHead) {
				// A new push: its runs are the ones that matter now, and they need
				// time to appear, so the no-run deadline starts again.
				this.headMoves.push({ from: this.currentHead, to: head })
				this.currentHead = head
				this.headSince = this.clock.now()
				this.runs = []
				this.settledRuns = undefined
			}
			const runs = await this.source.runs(head)
			if (this.done) {
				return
			}
			this.runs = runs
			this.failedPolls = 0
		} catch (error) {
			if (this.done) {
				return
			}
			this.failedPolls++
			if (this.failedPolls >= this.timings.maxFailures) {
				this.finish({ kind: "api_errors", error: error instanceof Error ? error.message : String(error) })
				return
			}
			this.next()
			return
		}

		const failed = this.runs.filter(isFailure)
		if (this.until === "first_failure" && failed.length > 0) {
			await this.finishWithReports("first_failure", failed)
			return
		}
		if (this.runs.length > 0 && this.runs.every((run) => run.status === "completed")) {
			// Workflows for one push are not all created at the same instant, so a
			// quick one can finish before a slow one is listed. Report only when two
			// polls in a row see the same runs, all complete.
			const settled = this.runs
				.map((run) => run.id)
				.sort((a, b) => a - b)
				.join(",")
			if (settled === this.settledRuns) {
				await this.finishWithReports("finished", failed)
				return
			}
			this.settledRuns = settled
		} else {
			this.settledRuns = undefined
		}
		if (this.runs.length === 0 && this.clock.now() - this.headSince >= this.timings.noRunsMs) {
			this.finish({ kind: "no_runs" })
			return
		}
		this.next()
	}

	/** Schedules the next poll, unless the watch has run out of time. */
	private next(): void {
		if (this.clock.now() - this.startedAt >= this.timings.maxMs) {
			this.finish({ kind: "timeout" })
			return
		}
		this.schedule()
	}

	private async finishWithReports(kind: "finished" | "first_failure", failed: PipelineRun[]): Promise<void> {
		const reports: RunReport[] = []
		for (const run of failed.slice(0, this.timings.maxReports)) {
			try {
				reports.push(await this.source.report(run.id))
			} catch {
				// The summary still names the failed run; its details can be read with pipeline_report.
			}
			if (this.done) {
				return
			}
		}
		this.finish({ kind, reports })
	}

	private finish(
		outcome:
			| { kind: "finished" | "first_failure"; reports: RunReport[] }
			| { kind: "no_runs" | "timeout" }
			| { kind: "api_errors"; error: string },
	): void {
		if (this.done) {
			return
		}
		this.done = true
		this.clock.clearTimeout(this.timer)
		this.onOutcome({ ...outcome, head: this.currentHead, headMoves: this.headMoves, runs: this.runs })
	}
}
