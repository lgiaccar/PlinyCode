/**
 * Auto-watch: for targets that have it on, starts Fix conflicts when a pull
 * request conflicts, and Recalibrate when a free model's triage says every
 * failure is a small test delta. Nothing else runs automatically: build
 * failures, regressions and infrastructure problems are left for the user.
 * Each start is capped per commit and per item, and runs in the background on
 * the free model. No `vscode` import.
 */
import type { CiWatchClock } from "../ci-watch/ci-watcher"
import { SYSTEM_CLOCK } from "../ci-watch/ci-watcher"
import type { CiBoard } from "./ci-board"
import { fingerprintOf } from "./ci-triage"
import type { CiAction, CiBoardItem, CiTarget } from "./types"

/** How sure the triage must be that every failure is a small test delta. */
const SMALL_DELTA_CONFIDENCE = 0.7
/** After a run ends, CI needs a moment to see its push. */
const SETTLE_MS = 2 * 60_000
const RETRY_MS = 30_000

export type CiAutoStatus = "idle" | "waiting_ci" | "queued" | "waiting_slot" | "running" | "capped" | "needs_you"

export interface CiAutoState {
	status: CiAutoStatus
	actionId?: string
	attempt?: number
	maxAttempts?: number
	message: string
}

export interface CiAutoSettings {
	/** Runs of one action on one commit. */
	maxAttemptsPerHead: number
	/** Runs of one action on one item until it turns green. */
	maxRunsPerItem: number
	/** Auto-watch runs at once. */
	maxConcurrent: number
}

export type CiAutoStartResult = "started" | "full" | { error: string }

export interface CiAutoRunnerDeps {
	board: Pick<
		CiBoard,
		| "view"
		| "runBlockedReason"
		| "linkFor"
		| "onDidChange"
		| "autoAttempts"
		| "recordAutoAttempt"
		| "resetAutoAttempts"
		| "triageFor"
		| "skillsFor"
		| "touch"
	>
	start(targetId: string, itemKey: string, actionId: string): Promise<CiAutoStartResult>
	/** Whether a conversation is still running (on screen or in the background). */
	isActive(conversationId: string): boolean
	/** Background slots free now; auto-watch always leaves one for the user. */
	freeSlots(): number
	onBackgroundReleased(listener: (conversationId: string) => void): () => void
	notify(kind: "started" | "needs_you" | "capped", message: string, conversationId?: string): void
	settings(): CiAutoSettings
	clock?: CiWatchClock
}

const headKey = (key: string, actionId: string, headSha?: string) => `${key}|${actionId}|${headSha ?? ""}`
const streakKey = (key: string, actionId: string) => `${key}|${actionId}`

export class CiAutoRunner {
	private readonly states = new Map<string, CiAutoState>()
	private readonly starting = new Set<string>()
	/** When each item's last auto run left the background. */
	private readonly settledAt = new Map<string, number>()
	/** `key|fingerprint` already notified as needing the user. */
	private readonly notified = new Set<string>()
	/** Starts that failed, kept until the item's state changes so they are not retried in a loop. */
	private readonly failed = new Map<string, { fingerprint?: string; state: CiAutoState }>()
	private readonly clock: CiWatchClock
	private readonly disposers: (() => void)[] = []
	private timer: unknown
	private evaluating = false
	private again = false
	private disposed = false

	constructor(private readonly deps: CiAutoRunnerDeps) {
		this.clock = deps.clock ?? SYSTEM_CLOCK
		this.disposers.push(deps.board.onDidChange(() => this.evaluate()))
		this.disposers.push(
			deps.onBackgroundReleased((conversationId) => {
				for (const view of deps.board.view()) {
					for (const item of view.items) {
						if (deps.board.linkFor(item.key)?.conversationId === conversationId) {
							this.settledAt.set(item.key, this.clock.now())
						}
					}
				}
				this.evaluate()
			}),
		)
	}

	state(key: string): CiAutoState | undefined {
		return this.states.get(key)
	}

	evaluate(): void {
		if (this.disposed) return
		if (this.evaluating) {
			this.again = true
			return
		}
		this.evaluating = true
		try {
			do {
				this.again = false
				this.pass()
			} while (this.again && !this.disposed)
		} finally {
			this.evaluating = false
		}
	}

	dispose(): void {
		this.disposed = true
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
		for (const dispose of this.disposers) dispose()
	}

	private pass(): void {
		const settings = this.deps.settings()
		const seen = new Set<string>()
		let changed = false
		let retry = false
		let running = 0
		const candidates: { target: CiTarget; item: CiBoardItem; action: CiAction }[] = []
		const set = (key: string, state: CiAutoState) => {
			seen.add(key)
			const before = this.states.get(key)
			if (
				!before ||
				before.status !== state.status ||
				before.message !== state.message ||
				before.attempt !== state.attempt
			) {
				changed = true
			}
			this.states.set(key, state)
		}

		for (const view of this.deps.board.view()) {
			if (!view.target.autoWatch) continue
			for (const item of view.items) {
				if (seen.has(item.key)) continue
				const link = this.deps.board.linkFor(item.key)
				if (this.starting.has(item.key) || (link?.auto && this.deps.isActive(link.conversationId))) {
					running++
					const attempt = link ? this.deps.board.autoAttempts(headKey(item.key, link.actionId, link.headSha)) : 1
					set(item.key, {
						status: "running",
						actionId: link?.actionId,
						attempt,
						maxAttempts: settings.maxAttemptsPerHead,
						message: `Auto-watch is running ${labelOf(view.target, link?.actionId)} (attempt ${attempt} of ${settings.maxAttemptsPerHead}).`,
					})
					continue
				}
				const failure = this.failed.get(item.key)
				if (failure && failure.fingerprint === fingerprintOf(item)) {
					set(item.key, failure.state)
					continue
				}
				this.failed.delete(item.key)
				const decision = this.decide(view.target, item, settings)
				if (decision.kind === "state") {
					set(item.key, decision.state)
					retry ||= decision.state.status === "waiting_ci" && this.settling(item.key)
					if (decision.state.status === "needs_you" || decision.state.status === "capped") {
						this.notifyOnce(item, decision.state)
					}
				} else {
					candidates.push({ target: view.target, item, action: decision.action })
				}
			}
		}

		for (const { target, item, action } of candidates) {
			const attempt = this.deps.board.autoAttempts(headKey(item.key, action.id, item.headSha)) + 1
			const base = { actionId: action.id, attempt, maxAttempts: settings.maxAttemptsPerHead }
			if (running >= settings.maxConcurrent) {
				set(item.key, { ...base, status: "queued", message: `${action.label} is queued behind another auto-watch run.` })
				continue
			}
			if (this.deps.freeSlots() <= 1) {
				set(item.key, {
					...base,
					status: "waiting_slot",
					message: `${action.label} waits for a free background slot (one is always kept for your own tasks).`,
				})
				retry = true
				continue
			}
			running++
			set(item.key, { ...base, status: "running", message: `Auto-watch is starting ${action.label} (attempt ${attempt}).` })
			void this.launch(target, item, action, attempt, settings)
		}

		for (const key of [...this.states.keys()]) {
			if (!seen.has(key)) {
				this.states.delete(key)
				changed = true
			}
		}
		if (retry) this.scheduleRetry()
		if (changed) this.deps.board.touch()
	}

	private decide(
		target: CiTarget,
		item: CiBoardItem,
		settings: CiAutoSettings,
	): { kind: "state"; state: CiAutoState } | { kind: "run"; action: CiAction } {
		const idle = (message: string): { kind: "state"; state: CiAutoState } => ({
			kind: "state",
			state: { status: "idle", message },
		})
		const needsYou = (message: string, actionId?: string): { kind: "state"; state: CiAutoState } => ({
			kind: "state",
			state: { status: "needs_you", actionId, message },
		})
		const blocked = this.deps.board.runBlockedReason(target, item)
		if (blocked) return idle(blocked)
		if (item.pr?.draft) return idle("Auto-watch leaves draft pull requests alone.")
		if (item.error) return idle("The board could not read this item; auto-watch waits.")

		const fingerprint = fingerprintOf(item)
		if (!fingerprint) {
			if (item.pipelines.length && item.pipelines.every((p) => p.color === "green" || p.color === "grey")) {
				void this.deps.board.resetAutoAttempts(`${item.key}|`)
			}
			return idle(
				item.pipelines.some((p) => p.color === "yellow") ? "Watching: CI is running." : "Watching: nothing to fix.",
			)
		}
		if (this.settling(item.key)) {
			return {
				kind: "state",
				state: { status: "waiting_ci", message: "Waiting for CI to pick up the last auto-watch run." },
			}
		}

		let action: CiAction | undefined
		if (item.mergeState === "conflicts") {
			action = target.actions.find((a) => a.id === "fix-conflicts")
			if (!action?.auto)
				return needsYou("This pull request conflicts, and auto-watch may not run Fix conflicts (see Edit actions).")
		} else {
			if (item.pipelines.some((p) => p.color === "yellow")) {
				return { kind: "state", state: { status: "waiting_ci", message: "Waiting for the other pipelines to finish." } }
			}
			const triage = this.deps.board.triageFor(item)
			if (!triage || triage.stale || triage.result.status === "pending") {
				return { kind: "state", state: { status: "waiting_ci", message: "Waiting for the failure analysis." } }
			}
			const result = triage.result
			const categories = result.pipelines.map((p) => p.category)
			const allSmall = categories.length > 0 && categories.every((c) => c === "small-test-delta")
			if (result.source !== "model" || !allSmall || (result.smallDeltaConfidence ?? 0) < SMALL_DELTA_CONFIDENCE) {
				const what = describeBlocking(
					result.pipelines.map((p) => ({ name: p.name, category: p.category })),
					result.source,
				)
				return needsYou(
					`${what} Auto-watch fixes only conflicts and small test deltas; use Fix build, Fix them all or Investigate.`,
				)
			}
			action = target.actions.find((a) => a.id === "recalibrate")
			if (!action?.auto)
				return needsYou(
					"The failures look like small test deltas, but auto-watch may not run Recalibrate (see Edit actions).",
					"recalibrate",
				)
			if (action.prompt.kind === "builtin" && !this.deps.board.skillsFor(target.id).recalibrate.length) {
				return needsYou(
					"The failures look like small test deltas, but this repository has no recalibration skill. Give Recalibrate a prompt in Edit actions, or run it yourself.",
					"recalibrate",
				)
			}
		}

		const attempts = this.deps.board.autoAttempts(headKey(item.key, action.id, item.headSha))
		if (attempts >= settings.maxAttemptsPerHead) {
			return {
				kind: "state",
				state: {
					status: "capped",
					actionId: action.id,
					attempt: attempts,
					maxAttempts: settings.maxAttemptsPerHead,
					message: `${action.label} already ran ${attempts} times on this commit; it needs you.`,
				},
			}
		}
		const streak = this.deps.board.autoAttempts(streakKey(item.key, action.id))
		if (streak >= settings.maxRunsPerItem) {
			return {
				kind: "state",
				state: {
					status: "capped",
					actionId: action.id,
					attempt: attempts,
					maxAttempts: settings.maxAttemptsPerHead,
					message: `${action.label} ran ${streak} times on this pull request without getting it green; it needs you.`,
				},
			}
		}
		return { kind: "run", action }
	}

	private async launch(
		target: CiTarget,
		item: CiBoardItem,
		action: CiAction,
		attempt: number,
		settings: CiAutoSettings,
	): Promise<void> {
		this.starting.add(item.key)
		let result: CiAutoStartResult
		try {
			await this.deps.board.recordAutoAttempt([headKey(item.key, action.id, item.headSha), streakKey(item.key, action.id)])
			result = await this.deps.start(target.id, item.key, action.id)
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error) }
		} finally {
			this.starting.delete(item.key)
		}
		const where = item.pr ? `PR #${item.pr.id}` : item.branch
		if (result === "started") {
			this.deps.notify(
				"started",
				`Auto-watch started ${action.label} on ${where} (attempt ${attempt} of ${settings.maxAttemptsPerHead}).`,
				this.deps.board.linkFor(item.key)?.conversationId,
			)
		} else if (result === "full") {
			this.scheduleRetry()
		} else {
			const state: CiAutoState = {
				status: "needs_you",
				actionId: action.id,
				message: `Auto-watch could not start ${action.label}: ${result.error}`,
			}
			this.failed.set(item.key, { fingerprint: fingerprintOf(item), state })
			this.states.set(item.key, state)
			this.notifyOnce(item, state)
		}
		this.evaluate()
	}

	private settling(key: string): boolean {
		const at = this.settledAt.get(key)
		return at !== undefined && this.clock.now() - at < SETTLE_MS
	}

	private notifyOnce(item: CiBoardItem, state: CiAutoState): void {
		const id = `${item.key}|${fingerprintOf(item) ?? item.headSha ?? ""}|${state.status}`
		if (this.notified.has(id)) return
		this.notified.add(id)
		const where = item.pr ? `PR #${item.pr.id}` : item.branch
		this.deps.notify(state.status === "capped" ? "capped" : "needs_you", `${where}: ${state.message}`)
	}

	private scheduleRetry(): void {
		if (this.timer !== undefined || this.disposed) return
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined
			this.evaluate()
		}, RETRY_MS)
	}
}

function labelOf(target: CiTarget, actionId?: string): string {
	return target.actions.find((a) => a.id === actionId)?.label ?? "an action"
}

const CATEGORY_WORDS: Record<string, string> = {
	build: "a build failure",
	"test-regression": "test failures",
	"small-test-delta": "small test deltas",
	infrastructure: "an infrastructure problem",
	stale: "a stale run",
	unknown: "an unclassified failure",
}

function describeBlocking(pipelines: { name: string; category: string }[], source: "model" | "heuristic"): string {
	const blocking = pipelines.filter((p) => p.category !== "small-test-delta")
	if (!blocking.length) {
		return source === "model"
			? "The free model is not sure enough that these are small test deltas."
			: "Only rules classified these failures (the model did not answer), so they are not trusted as small deltas."
	}
	const first = blocking[0]
	const more = blocking.length > 1 ? ` and ${blocking.length - 1} more` : ""
	return `${first.name} has ${CATEGORY_WORDS[first.category] ?? "a failure"}${more}.`
}
