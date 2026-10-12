/**
 * The CI board of one window: its targets (saved per window workspace), what
 * the poller last saw for each, the triage of their failures, and the
 * conversations its actions started.
 */
import { randomUUID } from "node:crypto"
import type { Mode } from "@shared/storage/types"
import { DevOpsError } from "../server/errors"
import type { Provider } from "../server/providers/types"
import { loadContext, parseRemote, type Remote, type RepoContext, sameRepository } from "../server/repo"
import { BUILTIN_PROMPTS } from "./builtin-prompts"
import type { CiAutoState } from "./ci-auto-runner"
import { CiBoardPoller, type CiBoardPollerOptions, type CiBoardTimings } from "./ci-board-poller"
import type { CiBoardStore } from "./ci-board-store"
import { composeCiPrompt, loadPromptText } from "./ci-prompt"
import { type CiSkills, detectCiSkills, noSkills } from "./ci-skills"
import { CiTriage, type CiTriageMode, type CompleteFn, fingerprintOf } from "./ci-triage"
import { classifyTargetInput, parsePrLink } from "./pr-link"
import { ensureReportDir } from "./report-dir"
import {
	type CiAction,
	type CiAutoAttempt,
	type CiBoardItem,
	type CiLink,
	type CiModelChoice,
	type CiPromptSource,
	type CiTarget,
	type CiTransition,
	type CiTriageResult,
	defaultActions,
	isBuiltinId,
	withBuiltins,
} from "./types"
import { type EnsuredWorktree, ensureWorktree, worktreeRoot } from "./worktrees"

export type CiTargetInput =
	| { kind: "pr"; url: string }
	| { kind: "branch"; repoRoot: string; branch: string }
	| { kind: "repo"; repoRoot: string; prFilter: "mine" | "all" }

export interface CiTargetPatch {
	autoWatch?: boolean
	actions?: CiAction[]
	prFilter?: "mine" | "all"
}

export interface CiTargetView {
	target: CiTarget
	items: CiBoardItem[]
	error?: string
	loading: boolean
	/** The local checkout runs use; undefined when this window has none for the repository. */
	checkout?: string
}

interface CiBoardOptions {
	store: CiBoardStore
	/** The window workspace the board belongs to. */
	workspacePath: string
	providerFor(remote: Remote): Provider
	/** A checkout in this window whose remote is `remote`. */
	resolveCheckout(remote: Remote): Promise<string | undefined>
	maxPrsPerRepo(): number
	/** `plinycode.ci.worktreeRoot`; empty means next to the repository. */
	worktreeFolder(): string | undefined
	loadRepo?: (root: string) => Promise<RepoContext>
	poller?: Pick<CiBoardPollerOptions, "clock" | "timings">
	/** One request to the free utility model, for triage; rules only when absent. */
	complete?: CompleteFn
	/** `plinycode.ci.board.triage`; `auto` when absent. */
	triageMode?: () => CiTriageMode
	/** Where a checkout's reports go; `.plinycode/ci-reports` in it by default. */
	reportDir?: (checkout: string) => Promise<string>
	/** Finds the repository's skills; `detectCiSkills` by default. */
	detectSkills?: (root: string) => Promise<CiSkills>
}

/** What to run: one of the target's actions, or a prompt typed or picked for this run only. */
export type CiRunRequest = { actionId: string } | { custom: CiPromptSource; label: string; model: CiModelChoice }

export interface PreparedCiRun {
	prompt: string
	worktree: EnsuredWorktree
	item: CiBoardItem
	action: CiAction
	/** The mode the conversation runs in. */
	mode: Mode
	remoteName: string
	sourceBranch: string
	/** The checkout's report folder, which runs may read. */
	reportDir?: string
}

type Listener<T> = (value: T) => void

const remoteOf = (target: CiTarget) => parseRemote(target.remoteUrl, target.provider)

export class CiBoard {
	private targets: CiTarget[] = []
	private links: Record<string, CiLink> = {}
	private attempts: CiAutoAttempt[] = []
	private readonly checkouts = new Map<string, string | undefined>()
	private readonly skills = new Map<string, CiSkills>()
	private readonly poller: CiBoardPoller
	private triageService?: CiTriage
	private readonly changeListeners = new Set<Listener<void>>()
	private readonly transitionListeners = new Set<Listener<CiTransition>>()
	private readonly loadRepo: (root: string) => Promise<RepoContext>
	private viewers = 0
	private disposed = false
	private autoStateOf?: (key: string) => CiAutoState | undefined

	constructor(private readonly options: CiBoardOptions) {
		this.loadRepo = options.loadRepo ?? loadContext
		this.poller = new CiBoardPoller({
			...options.poller,
			providerFor: (target) => options.providerFor(remoteOf(target)),
			maxPrsPerRepo: options.maxPrsPerRepo,
			onUpdate: () => this.emitChange(),
			onTransition: (transition) => {
				for (const listener of this.transitionListeners) listener(transition)
			},
		})
	}

	async init(): Promise<void> {
		const data = await this.options.store.load(this.options.workspacePath)
		this.targets = data.targets
		this.links = data.links
		this.attempts = data.autoAttempts
		this.triageService = new CiTriage({
			providerFor: (target) => this.options.providerFor(remoteOf(target)),
			complete: this.options.complete,
			checkoutFor: (target) => this.checkouts.get(target.id),
			reportDir: async (target) => {
				const checkout = this.checkouts.get(target.id)
				return checkout ? (this.options.reportDir ?? ensureReportDir)(checkout) : undefined
			},
			mode: () => this.options.triageMode?.() ?? "auto",
			onChange: () => this.emitChange(),
			persist: (results) => void this.persistTriage(results),
			restored: data.triage,
			clock: this.options.poller?.clock,
		})
		await Promise.all(this.targets.map((t) => this.resolveCheckout(t)))
		this.poller.setTargets(this.targets)
		this.emitChange()
	}

	view(): CiTargetView[] {
		return this.targets.map((target) => ({
			target,
			...this.poller.snapshot(target.id),
			checkout: this.checkouts.get(target.id),
		}))
	}

	get rateLimited(): boolean {
		return this.poller.rateLimited
	}

	target(id: string): CiTarget | undefined {
		return this.targets.find((t) => t.id === id)
	}

	item(targetId: string, key: string): CiBoardItem | undefined {
		return this.poller.snapshot(targetId).items.find((i) => i.key === key)
	}

	linkFor(key: string): CiLink | undefined {
		return this.links[key]
	}

	/** The item key whose last run is `conversationId`. */
	linkOfConversation(conversationId: string): { key: string; link: CiLink } | undefined {
		for (const [key, link] of Object.entries(this.links)) {
			if (link.conversationId === conversationId) return { key, link }
		}
		return undefined
	}

	checkoutFor(targetId: string): string | undefined {
		return this.checkouts.get(targetId)
	}

	/** The repository's skills for the built-in actions, as last scanned in the target's checkout. */
	skillsFor(targetId: string): CiSkills {
		return this.skills.get(targetId) ?? noSkills()
	}

	/** The item's triage, and whether it describes an older state of the item. */
	triageFor(item: CiBoardItem): { result: CiTriageResult; stale: boolean } | undefined {
		const result = this.triageService?.get(item.key)
		if (!result) return undefined
		return { result, stale: result.fingerprint !== fingerprintOf(item) }
	}

	/** Analyses an item's failures now, even when they were analysed already. */
	async analyze(targetId: string, key: string): Promise<CiTriageResult> {
		const target = this.target(targetId)
		const item = target && this.item(targetId, key)
		if (!target || !item || !this.triageService) {
			throw new DevOpsError("That CI board entry changed; refresh the board and try again.")
		}
		return this.triageService.request(target, item)
	}

	async addTarget(input: CiTargetInput): Promise<CiTarget> {
		const base = { autoWatch: false, actions: defaultActions(), createdTs: Date.now() }
		let target: CiTarget
		if (input.kind === "pr") {
			const link = parsePrLink(input.url)
			if (!link) {
				throw new DevOpsError(
					"That is not a pull request link. Use a GitHub …/pull/N or Azure DevOps …/pullrequest/N link.",
				)
			}
			target = {
				...base,
				id: randomUUID(),
				kind: "pr",
				remoteUrl: link.remoteUrl,
				provider: link.remote.kind,
				prId: link.prId,
			}
		} else {
			if (input.kind === "branch") {
				const typed = classifyTargetInput(input.branch)
				if (typed.kind !== "branch") {
					throw new DevOpsError(
						typed.kind === "invalid" ? typed.reason : "Paste the pull request link as a pull request.",
					)
				}
			}
			const ctx = await this.loadRepo(input.repoRoot)
			if (!ctx.remoteUrl) {
				throw new DevOpsError(`Cannot read the URL of remote '${ctx.remoteName}' in ${ctx.root}.`)
			}
			target = {
				...base,
				id: randomUUID(),
				kind: input.kind,
				remoteUrl: ctx.remoteUrl,
				provider: ctx.remote.kind,
				repoRoot: ctx.root,
				...(input.kind === "branch" ? { branch: input.branch.trim() } : { prFilter: input.prFilter }),
			}
		}
		const duplicate = this.targets.find((t) => sameSelection(t, target))
		if (duplicate) {
			return duplicate
		}
		await this.resolveCheckout(target)
		await this.save((data) => ({ ...data, targets: [...data.targets.filter((t) => t.id !== target.id), target] }))
		return target
	}

	async updateTarget(id: string, patch: CiTargetPatch): Promise<CiTarget> {
		const current = this.target(id)
		if (!current) {
			throw new DevOpsError("That CI board entry no longer exists.")
		}
		const next: CiTarget = { ...current, ...patch }
		if (patch.actions) next.actions = withBuiltins(patch.actions)
		await this.save((data) => ({ ...data, targets: data.targets.map((t) => (t.id === id ? next : t)) }))
		return next
	}

	async removeTarget(id: string): Promise<void> {
		this.checkouts.delete(id)
		this.skills.delete(id)
		await this.save((data) => ({ ...data, targets: data.targets.filter((t) => t.id !== id) }))
	}

	async setLink(key: string, link: CiLink): Promise<void> {
		await this.save((data) => ({ ...data, links: { ...data.links, [key]: link } }))
	}

	/** How often auto-watch started something under `key` (`item|action|head` or `item|action`). */
	autoAttempts(key: string): number {
		return this.attempts.find((a) => a.key === key)?.count ?? 0
	}

	async recordAutoAttempt(keys: string[]): Promise<void> {
		const now = this.options.poller?.clock?.now() ?? Date.now()
		await this.save((data) => {
			const attempts = [...data.autoAttempts]
			for (const key of keys) {
				const found = attempts.findIndex((a) => a.key === key)
				const count = (found >= 0 ? attempts[found].count : 0) + 1
				if (found >= 0) attempts.splice(found, 1)
				attempts.push({ key, count, lastTs: now })
			}
			return { ...data, autoAttempts: attempts }
		})
	}

	/** Forgets the attempt counters that start with `prefix`, e.g. when an item turns green. */
	async resetAutoAttempts(prefix: string): Promise<void> {
		if (!this.attempts.some((a) => a.key.startsWith(prefix))) return
		await this.save((data) => ({ ...data, autoAttempts: data.autoAttempts.filter((a) => !a.key.startsWith(prefix)) }))
	}

	refresh(targetId?: string): Promise<void> {
		return this.poller.refresh(targetId)
	}

	setTimings(timings: Partial<CiBoardTimings>): void {
		this.poller.setTimings(timings)
	}

	/** Counts the board's viewers; it polls faster while any is open. Returns the release. */
	openView(): () => void {
		this.viewers++
		this.poller.setVisible(true)
		let released = false
		return () => {
			if (released) return
			released = true
			this.viewers--
			this.poller.setVisible(this.viewers > 0)
		}
	}

	onDidChange(listener: Listener<void>): () => void {
		this.changeListeners.add(listener)
		return () => this.changeListeners.delete(listener)
	}

	onTransition(listener: Listener<CiTransition>): () => void {
		this.transitionListeners.add(listener)
		return () => this.transitionListeners.delete(listener)
	}

	/** Tells the board's views that something they show changed outside the board, e.g. a run's status. */
	touch(): void {
		this.emitChange()
	}

	/** Where auto-watch's per-item status comes from (the host's `CiAutoRunner`). */
	setAutoStates(source: ((key: string) => CiAutoState | undefined) | undefined): void {
		this.autoStateOf = source
	}

	/** What auto-watch is doing about an item, when its target has auto-watch on. */
	autoState(key: string): CiAutoState | undefined {
		return this.autoStateOf?.(key)
	}

	/**
	 * Gets a working copy for the item's branch and builds the run's prompt.
	 * Refuses what a run cannot fix from here: a fork's branch, or a repository
	 * this window has no checkout of.
	 */
	async prepareRun(
		targetId: string,
		key: string,
		request: CiRunRequest,
		options: { auto?: boolean } = {},
	): Promise<PreparedCiRun> {
		const target = this.target(targetId)
		const item = target && this.item(targetId, key)
		const action: CiAction | undefined =
			"actionId" in request
				? target?.actions.find((a) => a.id === request.actionId)
				: {
						id: "custom",
						label: request.label,
						prompt: request.custom,
						model: request.model,
						situation: "any",
						auto: false,
					}
		if (!target || !item || !action) {
			throw new DevOpsError("That CI board entry changed; refresh the board and try again.")
		}
		const blocked = this.runBlockedReason(target, item)
		if (blocked) {
			throw new DevOpsError(blocked)
		}
		const repoRoot = this.checkouts.get(targetId) as string
		const ctx = await this.loadRepo(repoRoot)
		const sourceBranch = item.pr?.sourceBranch ?? item.branch
		const worktree = await ensureWorktree({
			repoRoot: ctx.root,
			remoteName: ctx.remoteName,
			branch: sourceBranch,
			root: worktreeRoot(ctx.root, this.options.worktreeFolder()),
		})
		const body = await loadPromptText(action.prompt, [worktree.path, ctx.root])
		const builtin = action.prompt.kind === "builtin" ? action.prompt.id : isBuiltinId(action.id) ? action.id : undefined
		const skills = builtin
			? (await (this.options.detectSkills ?? detectCiSkills)(worktree.path).catch(() => noSkills()))[builtin]
			: undefined
		const triage = this.triageFor(item)
		const prompt = composeCiPrompt(
			{
				item,
				worktree: worktree.path,
				inPlace: worktree.inPlace,
				remoteName: ctx.remoteName,
				notes: worktree.notes,
				triage: triage && !triage.stale ? triage.result : undefined,
				builtin,
				skills,
				auto: options.auto,
			},
			body,
		)
		const mode: Mode = action.prompt.kind === "builtin" ? BUILTIN_PROMPTS[action.prompt.id].mode : "act"
		const reportDir = await (this.options.reportDir ?? ensureReportDir)(ctx.root).catch(() => undefined)
		return { prompt, worktree, item, action, mode, remoteName: ctx.remoteName, sourceBranch, reportDir }
	}

	/** Why an action cannot run on `item`, or undefined when it can. */
	runBlockedReason(target: CiTarget, item: CiBoardItem): string | undefined {
		if (item.fork) {
			return "This pull request comes from a fork; its branch cannot be pushed to from here."
		}
		if (item.pr && item.pr.state !== "open") {
			return `This pull request is ${item.pr.state}.`
		}
		if (!this.checkouts.get(target.id)) {
			return "No folder open in this window is a checkout of this repository. Open one, then refresh the board."
		}
		return undefined
	}

	dispose(): void {
		this.disposed = true
		this.poller.dispose()
		this.triageService?.dispose()
		this.changeListeners.clear()
		this.transitionListeners.clear()
	}

	private async resolveCheckout(target: CiTarget): Promise<void> {
		if (target.repoRoot) {
			this.checkouts.set(target.id, target.repoRoot)
		} else {
			try {
				this.checkouts.set(target.id, await this.options.resolveCheckout(remoteOf(target)))
			} catch {
				this.checkouts.set(target.id, undefined)
			}
		}
		const checkout = this.checkouts.get(target.id)
		if (checkout) {
			const skills = await (this.options.detectSkills ?? detectCiSkills)(checkout).catch(() => noSkills())
			this.skills.set(target.id, skills)
		}
	}

	/** Recomputes which open folders back the board's pull request links, e.g. after a folder is added. */
	async rescanCheckouts(): Promise<void> {
		await Promise.all(this.targets.map((t) => this.resolveCheckout(t)))
		this.emitChange()
	}

	private async save(change: Parameters<CiBoardStore["update"]>[1]): Promise<void> {
		const data = await this.options.store.update(this.options.workspacePath, change)
		this.targets = data.targets
		this.links = data.links
		this.attempts = data.autoAttempts
		this.poller.setTargets(this.targets)
		this.emitChange()
	}

	private async persistTriage(results: Record<string, CiTriageResult>): Promise<void> {
		if (this.disposed) return
		await this.options.store
			.update(this.options.workspacePath, (data) => ({ ...data, triage: results }))
			.catch(() => undefined)
	}

	private emitChange(): void {
		if (this.disposed) return
		this.triageService?.scan(this.view())
		for (const listener of this.changeListeners) listener()
	}
}

function sameSelection(a: CiTarget, b: CiTarget): boolean {
	if (a.kind !== b.kind) {
		return false
	}
	let sameRemote: boolean
	try {
		sameRemote = sameRepository(remoteOf(a), remoteOf(b))
	} catch {
		sameRemote = a.remoteUrl === b.remoteUrl
	}
	return sameRemote && a.branch === b.branch && a.prId === b.prId && a.prFilter === b.prFilter
}
