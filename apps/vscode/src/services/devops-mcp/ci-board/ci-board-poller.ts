/**
 * Polls the board's targets on plain timers. Each cycle lists every target's
 * pull requests (or branch head) but asks for runs only where something can
 * have changed: a new head commit, runs still going, a merge state still being
 * computed, or a snapshot older than `fullRefreshMs` (which catches re-runs).
 * An idle board of 20 pull requests thus costs one list call per cycle.
 */
import { runsForHead } from "../ci-watch/ci-watch-source"
import { type CiWatchClock, SYSTEM_CLOCK } from "../ci-watch/ci-watcher"
import type { Provider, PullRequest } from "../server/providers/types"
import { parseRemote, remoteKey } from "../server/repo"
import { diffItems, groupPipelines } from "./ci-board-snapshot"
import type { CiBoardItem, CiTarget, CiTransition } from "./types"

export interface CiBoardTimings {
	/** Between cycles while the board is on screen. */
	pollMs: number
	/** Between cycles while it is not; notifications still need polling. */
	hiddenPollMs: number
	fullRefreshMs: number
	/** Below this many requests left (GitHub), only new commits are looked at and cycles slow down. */
	lowRateLimit: number
	/** Items whose runs are fetched at once. */
	concurrency: number
}

const DEFAULT_CI_BOARD_TIMINGS: CiBoardTimings = {
	pollMs: 60_000,
	hiddenPollMs: 180_000,
	fullRefreshMs: 10 * 60_000,
	lowRateLimit: 500,
	concurrency: 4,
}

/** How much slower cycles run while the rate limit is low. */
const LOW_RATE_SLOWDOWN = 4

interface CiBoardTargetSnapshot {
	items: CiBoardItem[]
	error?: string
	/** True until the target's first cycle ends. */
	loading: boolean
}

export interface CiBoardPollerOptions {
	providerFor(target: CiTarget): Provider
	maxPrsPerRepo(): number
	onUpdate(targetId: string): void
	onTransition(transition: CiTransition): void
	clock?: CiWatchClock
	timings?: Partial<CiBoardTimings>
}

interface ItemState {
	item: CiBoardItem
	/** When the item's runs were last fetched. */
	detailTs: number
}

interface TargetState {
	target: CiTarget
	items: Map<string, ItemState>
	error?: string
	loading: boolean
	/** Fetch every item's runs on the next cycle. */
	force: boolean
}

interface Entry {
	pr?: PullRequest
	branch: string
	head?: string
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** Identifies a target's selection; changing it starts the target over. */
const selection = (t: CiTarget) => [t.kind, t.remoteUrl, t.provider, t.branch, t.prId, t.prFilter].join("|")

function targetRemoteKey(target: CiTarget): string {
	return remoteKey(parseRemote(target.remoteUrl, target.provider))
}

function itemKey(prefix: string, entry: { pr?: { id: number }; branch: string }): string {
	return entry.pr ? `${prefix}#${entry.pr.id}` : `${prefix}@${entry.branch}`
}

async function pool<T>(items: T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
	let next = 0
	const worker = async () => {
		while (next < items.length) {
			await run(items[next++])
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
}

export class CiBoardPoller {
	private readonly states = new Map<string, TargetState>()
	private readonly clock: CiWatchClock
	private timings: CiBoardTimings
	private visible = false
	private timer?: unknown
	private cycle?: Promise<void>
	private again = false
	private lastCycleTs = Number.NEGATIVE_INFINITY
	private lowRate = false
	private disposed = false

	constructor(private readonly options: CiBoardPollerOptions) {
		this.clock = options.clock ?? SYSTEM_CLOCK
		this.timings = { ...DEFAULT_CI_BOARD_TIMINGS, ...options.timings }
	}

	/** True while a provider reported a low rate limit on the last cycle. */
	get rateLimited(): boolean {
		return this.lowRate
	}

	setTargets(targets: CiTarget[]): void {
		const ids = new Set(targets.map((t) => t.id))
		for (const id of [...this.states.keys()]) {
			if (!ids.has(id)) this.states.delete(id)
		}
		let added = false
		for (const target of targets) {
			const state = this.states.get(target.id)
			if (state && selection(state.target) === selection(target)) {
				state.target = target
				continue
			}
			this.states.set(target.id, { target, items: new Map(), loading: true, force: true })
			added = true
		}
		if (added) {
			void this.poll()
		} else if (this.states.size === 0) {
			this.clock.clearTimeout(this.timer)
		}
	}

	setTimings(timings: Partial<CiBoardTimings>): void {
		this.timings = { ...this.timings, ...timings }
		if (!this.cycle) this.schedule()
	}

	setVisible(visible: boolean): void {
		this.visible = visible
		if (visible && this.clock.now() - this.lastCycleTs >= this.timings.pollMs) {
			void this.poll()
		} else if (!this.cycle) {
			this.schedule()
		}
	}

	/** Fetches everything again now, for one target or all of them. */
	refresh(targetId?: string): Promise<void> {
		for (const state of this.states.values()) {
			if (targetId === undefined || state.target.id === targetId) state.force = true
		}
		return this.poll()
	}

	/** Resolves when no cycle is running. */
	async whenIdle(): Promise<void> {
		while (this.cycle) {
			await this.cycle
		}
	}

	snapshot(targetId: string): CiBoardTargetSnapshot {
		const state = this.states.get(targetId)
		if (!state) {
			return { items: [], loading: false }
		}
		return { items: [...state.items.values()].map((s) => s.item), error: state.error, loading: state.loading }
	}

	dispose(): void {
		this.disposed = true
		this.clock.clearTimeout(this.timer)
		this.states.clear()
	}

	private schedule(): void {
		this.clock.clearTimeout(this.timer)
		if (this.disposed || this.states.size === 0) {
			return
		}
		const base = this.visible ? this.timings.pollMs : this.timings.hiddenPollMs
		this.timer = this.clock.setTimeout(() => void this.poll(), this.lowRate ? base * LOW_RATE_SLOWDOWN : base)
	}

	/** Runs a cycle, or asks the running one to go round again. */
	poll(): Promise<void> {
		if (this.cycle) {
			this.again = true
			return this.cycle
		}
		if (this.disposed || this.states.size === 0) {
			return Promise.resolve()
		}
		this.clock.clearTimeout(this.timer)
		this.again = false
		this.cycle = (async () => {
			let low = false
			for (const state of [...this.states.values()]) {
				if (this.disposed) return
				low = (await this.pollTarget(state)) || low
			}
			this.lowRate = low
		})().finally(() => {
			this.cycle = undefined
			this.lastCycleTs = this.clock.now()
			if (this.again) {
				void this.poll()
			} else {
				this.schedule()
			}
		})
		return this.cycle
	}

	/** Returns whether the target's provider is low on rate limit. */
	private async pollTarget(state: TargetState): Promise<boolean> {
		const { target } = state
		const force = state.force
		state.force = false
		let provider: Provider | undefined
		try {
			provider = this.options.providerFor(target)
			const prefix = targetRemoteKey(target)
			const entries = await this.list(provider, target)
			const lowRate = (provider.rateLimitRemaining ?? Number.POSITIVE_INFINITY) < this.timings.lowRateLimit
			const next = new Map<string, ItemState>()
			const now = this.clock.now()
			const fresh = new Map<string, ItemState>()
			await pool(entries, this.timings.concurrency, async (entry) => {
				const key = itemKey(prefix, entry)
				fresh.set(key, await this.detail(provider as Provider, key, entry, state.items.get(key), force, lowRate, now))
			})
			// Keep the listing's order (most recently updated first).
			for (const entry of entries) {
				const key = itemKey(prefix, entry)
				const item = fresh.get(key)
				if (item) next.set(key, item)
			}
			if (this.states.get(target.id) !== state) {
				return lowRate
			}
			for (const [key, current] of next) {
				const previous = state.items.get(key)
				if (!current.item.error && !previous?.item.error) {
					for (const transition of diffItems(target.id, previous?.item, current.item)) {
						this.options.onTransition(transition)
					}
				}
			}
			state.items = next
			state.error = undefined
			return lowRate
		} catch (error) {
			state.error = message(error)
			return false
		} finally {
			state.loading = false
			if (this.states.get(target.id) === state) {
				this.options.onUpdate(target.id)
			}
		}
	}

	private async list(provider: Provider, target: CiTarget): Promise<Entry[]> {
		switch (target.kind) {
			case "pr": {
				const pr = await provider.getPr(target.prId ?? 0)
				return [{ pr, branch: pr.sourceBranch, head: pr.headSha }]
			}
			case "branch": {
				const branch = target.branch ?? ""
				const pr = await provider.findOpenPr(branch)
				return [pr ? { pr, branch, head: pr.headSha } : { branch, head: await provider.branchHead(branch) }]
			}
			case "repo": {
				const prs = await provider.listOpenPrs({ mine: target.prFilter !== "all", limit: this.options.maxPrsPerRepo() })
				return prs.map((pr) => ({ pr, branch: pr.sourceBranch, head: pr.headSha }))
			}
		}
	}

	private async detail(
		provider: Provider,
		key: string,
		entry: Entry,
		previous: ItemState | undefined,
		force: boolean,
		lowRate: boolean,
		now: number,
	): Promise<ItemState> {
		const prev = previous?.item
		const stale =
			prev?.mergeState === "pending" ||
			prev?.pipelines.some((p) => p.color === "yellow") ||
			now - (previous?.detailTs ?? 0) >= this.timings.fullRefreshMs
		const needed = force || !prev || prev.error !== undefined || prev.headSha !== entry.head || (!lowRate && stale)
		if (!needed && prev && previous) {
			// A listing has no merge state on GitHub; keep the one fetched for this commit.
			const pr = entry.pr ? { ...entry.pr, mergeState: entry.pr.mergeState ?? prev.mergeState } : undefined
			return { item: { ...prev, pr, mergeState: pr?.mergeState ?? prev.mergeState }, detailTs: previous.detailTs }
		}
		try {
			let pr = entry.pr
			if (pr && pr.mergeState === undefined && pr.state === "open") {
				pr = await provider.getPr(pr.id)
			}
			const head = pr?.headSha ?? entry.head
			const runs = head ? await runsForHead(provider, pr, entry.branch, head) : []
			// Pipelines seen on this item before and missing now show grey.
			const known = prev?.pipelines.map((p) => p.name) ?? []
			return {
				item: {
					key,
					pr,
					branch: entry.branch,
					headSha: head,
					mergeState: pr?.mergeState,
					pipelines: groupPipelines(runs, known),
					fork: pr?.fork ?? false,
				},
				detailTs: now,
			}
		} catch (error) {
			const base: CiBoardItem = prev ?? {
				key,
				pr: entry.pr,
				branch: entry.branch,
				headSha: entry.head,
				pipelines: [],
				fork: entry.pr?.fork ?? false,
			}
			return { item: { ...base, error: message(error) }, detailTs: previous?.detailTs ?? 0 }
		}
	}
}
