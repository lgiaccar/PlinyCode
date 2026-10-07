/**
 * The CI board of one window: its targets (saved per window workspace), what
 * the poller last saw for each, and the conversations its actions started.
 */
import { randomUUID } from "node:crypto"
import { DevOpsError } from "../server/errors"
import type { Provider } from "../server/providers/types"
import { loadContext, parseRemote, type Remote, type RepoContext } from "../server/repo"
import { CiBoardPoller, type CiBoardPollerOptions, type CiBoardTimings, targetRemoteKey } from "./ci-board-poller"
import type { CiBoardStore } from "./ci-board-store"
import { composeCiPrompt, loadPromptText } from "./ci-prompt"
import { classifyTargetInput, parsePrLink } from "./pr-link"
import {
	type CiAction,
	type CiAutonomy,
	type CiBoardItem,
	type CiLink,
	type CiTarget,
	type CiTransition,
	DEFAULT_ACTIONS,
} from "./types"
import { type EnsuredWorktree, ensureWorktree, worktreeRoot } from "./worktrees"

export type CiTargetInput =
	| { kind: "pr"; url: string }
	| { kind: "branch"; repoRoot: string; branch: string }
	| { kind: "repo"; repoRoot: string; prFilter: "mine" | "all" }

export interface CiTargetPatch {
	autonomy?: CiAutonomy
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
}

interface PreparedCiRun {
	prompt: string
	worktree: EnsuredWorktree
	item: CiBoardItem
	action: CiAction
}

type Listener<T> = (value: T) => void

const remoteOf = (target: CiTarget) => parseRemote(target.remoteUrl, target.provider)

export class CiBoard {
	private targets: CiTarget[] = []
	private links: Record<string, CiLink> = {}
	private readonly checkouts = new Map<string, string | undefined>()
	private readonly poller: CiBoardPoller
	private readonly changeListeners = new Set<Listener<void>>()
	private readonly transitionListeners = new Set<Listener<CiTransition>>()
	private readonly loadRepo: (root: string) => Promise<RepoContext>
	private viewers = 0

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

	checkoutFor(targetId: string): string | undefined {
		return this.checkouts.get(targetId)
	}

	async addTarget(input: CiTargetInput): Promise<CiTarget> {
		const base = { autonomy: "manual" as const, actions: DEFAULT_ACTIONS.map((a) => ({ ...a })), createdTs: Date.now() }
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
		await this.save((data) => ({ ...data, targets: data.targets.map((t) => (t.id === id ? next : t)) }))
		return next
	}

	async removeTarget(id: string): Promise<void> {
		this.checkouts.delete(id)
		await this.save((data) => ({ ...data, targets: data.targets.filter((t) => t.id !== id) }))
	}

	async setLink(key: string, link: CiLink): Promise<void> {
		await this.save((data) => ({ ...data, links: { ...data.links, [key]: link } }))
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

	/**
	 * Gets a working copy for the item's branch and builds the action's prompt.
	 * Refuses what a run cannot fix from here: a fork's branch, or a repository
	 * this window has no checkout of.
	 */
	async prepareRun(targetId: string, key: string, actionId: string): Promise<PreparedCiRun> {
		const target = this.target(targetId)
		const item = target && this.item(targetId, key)
		const action = target?.actions.find((a) => a.id === actionId)
		if (!target || !item || !action) {
			throw new DevOpsError("That CI board entry changed; refresh the board and try again.")
		}
		const blocked = this.runBlockedReason(target, item)
		if (blocked) {
			throw new DevOpsError(blocked)
		}
		const repoRoot = this.checkouts.get(targetId) as string
		const ctx = await this.loadRepo(repoRoot)
		const worktree = await ensureWorktree({
			repoRoot: ctx.root,
			remoteName: ctx.remoteName,
			branch: item.pr?.sourceBranch ?? item.branch,
			root: worktreeRoot(ctx.root, this.options.worktreeFolder()),
		})
		const body = await loadPromptText(action.prompt, [worktree.path, ctx.root])
		const prompt = composeCiPrompt(
			{ item, worktree: worktree.path, inPlace: worktree.inPlace, remoteName: ctx.remoteName, notes: worktree.notes },
			body,
		)
		return { prompt, worktree, item, action }
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
		this.poller.dispose()
		this.changeListeners.clear()
		this.transitionListeners.clear()
	}

	private async resolveCheckout(target: CiTarget): Promise<void> {
		if (target.repoRoot) {
			this.checkouts.set(target.id, target.repoRoot)
			return
		}
		try {
			this.checkouts.set(target.id, await this.options.resolveCheckout(remoteOf(target)))
		} catch {
			this.checkouts.set(target.id, undefined)
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
		this.poller.setTargets(this.targets)
		this.emitChange()
	}

	private emitChange(): void {
		for (const listener of this.changeListeners) listener()
	}
}

function sameSelection(a: CiTarget, b: CiTarget): boolean {
	if (a.kind !== b.kind) {
		return false
	}
	let sameRemote: boolean
	try {
		sameRemote = targetRemoteKey(a).toLowerCase() === targetRemoteKey(b).toLowerCase()
	} catch {
		sameRemote = a.remoteUrl === b.remoteUrl
	}
	return sameRemote && a.branch === b.branch && a.prId === b.prId && a.prFilter === b.prFilter
}
