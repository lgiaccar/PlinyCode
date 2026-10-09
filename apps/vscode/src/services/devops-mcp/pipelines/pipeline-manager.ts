import { workspacePathsEqual } from "@shared/workspacePath"
import { Logger } from "@/shared/services/Logger"
import { DevOpsError } from "../server/errors"
import type { PipelineDefinition, PipelineProvider } from "../server/providers/types"
import { loadContext, parseRemote, type Remote, type RepoContext, sameRepository } from "../server/repo"
import { type PipelineSchema, validatePipelineInputs } from "./pipeline-inputs"
import type { PipelineLaunch, PipelineRunStore } from "./pipeline-run-store"

interface PipelineManagerOptions {
	store: PipelineRunStore
	repositories(): Promise<string[]>
	providerFor(remote: Remote): PipelineProvider
	loadRepo?: (root: string) => Promise<RepoContext>
	now?: () => number
}

interface QueuePipeline {
	id: string
	repoRoot: string
	pipelineId: number
	ref: string
	revision: string
	inputs: Record<string, unknown>
}

export class PipelineManager {
	private readonly listeners = new Set<() => void>()
	private readonly pending = new Map<string, Promise<PipelineLaunch>>()
	private launches: PipelineLaunch[] = []
	private timer?: ReturnType<typeof setTimeout>
	private polling?: Promise<void>
	private viewers = 0
	private disposed = false
	private readonly now: () => number
	private readonly rateLimitStates = new Map<string, { lowSince?: number; lastProbeTime?: number }>()

	private getRateLimitState(provider: PipelineProvider): {
		lowSince?: number
		lastProbeTime?: number
	} {
		const key = `${provider.kind}:${provider.repoUrl}`
		let state = this.rateLimitStates.get(key)
		if (!state) {
			state = {}
			this.rateLimitStates.set(key, state)
		}
		return state
	}
	private readonly loadRepo: (root: string) => Promise<RepoContext>

	constructor(private readonly options: PipelineManagerOptions) {
		this.now = options.now ?? (() => Date.now())
		this.loadRepo = options.loadRepo ?? loadContext
	}

	async init(): Promise<void> {
		this.launches = await this.options.store.load(200)
		this.emit()
		await this.refresh()
	}

	view(): PipelineLaunch[] {
		return this.launches
	}

	onDidChange(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	openView(): () => void {
		this.viewers++
		void this.refresh()
		return () => {
			this.viewers = Math.max(0, this.viewers - 1)
		}
	}

	private emit(): void {
		if (!this.disposed) for (const listener of this.listeners) listener()
	}

	private async repository(root: string): Promise<{ ctx: RepoContext; provider: PipelineProvider }> {
		if (!(await this.options.repositories()).some((folder) => workspacePathsEqual(folder, root))) {
			throw new DevOpsError("Select a repository in the current workspace.")
		}
		const ctx = await this.loadRepo(root)
		if (!ctx.remoteUrl) throw new DevOpsError("The repository has no supported remote.")
		return { ctx, provider: this.options.providerFor(ctx.remote) }
	}

	async listPipelines(root: string): Promise<PipelineDefinition[]> {
		return (await this.repository(root)).provider.listPipelines()
	}

	async defaultRef(root: string): Promise<string> {
		return (await this.repository(root)).provider.defaultBranch()
	}

	async inputs(root: string, pipelineId: number, ref: string): Promise<PipelineSchema> {
		this.validateSelection(pipelineId, ref)
		return (await this.repository(root)).provider.pipelineInputs(pipelineId, ref)
	}

	private validateSelection(pipelineId: number, ref: string): void {
		const invalidRef = !ref.trim() || Array.from(ref).some((character) => character.charCodeAt(0) <= 32)
		if (!Number.isSafeInteger(pipelineId) || pipelineId <= 0 || invalidRef) {
			throw new DevOpsError("Select a pipeline and a valid branch or ref.")
		}
	}

	queue(request: QueuePipeline): Promise<PipelineLaunch> {
		const pending = this.pending.get(request.id)
		if (pending) return pending
		const operation = this.dispatch(request).finally(() => this.pending.delete(request.id))
		this.pending.set(request.id, operation)
		return operation
	}

	private async dispatch(request: QueuePipeline): Promise<PipelineLaunch> {
		this.validateSelection(request.pipelineId, request.ref)
		const { ctx, provider } = await this.repository(request.repoRoot)
		const existing = await this.options.store.get(request.id)
		if (existing) {
			if (
				!sameRepository(parseRemote(existing.remoteUrl, existing.provider), ctx.remote) ||
				existing.pipeline.id !== request.pipelineId ||
				existing.ref !== request.ref
			) {
				throw new DevOpsError("This launch ID belongs to another request.")
			}
			return existing
		}
		const pipeline = (await provider.listPipelines()).find((definition) => definition.id === request.pipelineId)
		if (!pipeline) throw new DevOpsError("This pipeline is no longer available.")
		const schema = await provider.pipelineInputs(request.pipelineId, request.ref)
		if (!schema.revision || schema.revision !== request.revision)
			throw new DevOpsError("The pipeline changed. Reload its parameters before running.")
		validatePipelineInputs(schema, request.inputs)
		const record: PipelineLaunch = {
			id: request.id,
			repoRoot: ctx.root,
			remoteUrl: provider.repoUrl,
			provider: ctx.remote.kind,
			pipeline,
			ref: request.ref,
			revision: schema.revision,
			created: this.now(),
			state: "dispatching",
			url: pipeline.url,
		}
		if (!(await this.options.store.create(record))) {
			const saved = await this.options.store.get(request.id)
			if (!saved) throw new DevOpsError("Could not reserve this launch.")
			return saved
		}
		await this.reload()
		try {
			const response = await provider.queuePipeline(pipeline.id, request.ref, request.inputs)
			record.state = "accepted"
			record.runId = response.runId
			record.url = response.url
		} catch (error) {
			const rejected =
				error instanceof DevOpsError &&
				error.status !== undefined &&
				error.status >= 400 &&
				error.status < 500 &&
				error.status !== 408
			record.state = rejected ? "rejected" : "unknown"
			record.error = rejected
				? `The provider rejected the launch (HTTP ${(error as DevOpsError).status}). Check queue permissions and the pipeline configuration.`
				: "Dispatch could not be confirmed. Check the provider before launching again."
		}
		await this.options.store.update(record)
		await this.reload()
		void this.refresh()
		return record
	}

	async associate(id: string, runId: number): Promise<void> {
		const record = await this.options.store.get(id)
		if (
			!record ||
			record.runId ||
			!["accepted", "unknown"].includes(record.state) ||
			!Number.isSafeInteger(runId) ||
			runId <= 0
		) {
			throw new DevOpsError("Select an unresolved launch and a valid run ID.")
		}
		const run = await this.options.providerFor(parseRemote(record.remoteUrl, record.provider)).getRun(runId)
		const ref = record.ref.replace(/^refs\/(heads|tags)\//, "")
		if (
			run.pipelineId !== record.pipeline.id ||
			run.branch.replace(/^refs\/(heads|tags)\//, "") !== ref ||
			!run.started ||
			!Number.isFinite(Date.parse(run.started)) ||
			Date.parse(run.started) < record.created - 60_000 ||
			(record.provider === "github" && run.event !== "workflow_dispatch")
		) {
			throw new DevOpsError("This run does not match the pipeline, ref and launch time.")
		}
		await this.options.store.update({
			...record,
			state: "accepted",
			runId,
			run,
			url: run.url,
			updated: this.now(),
			error: undefined,
		})
		await this.reload()
		void this.refresh()
	}

	private async reload(): Promise<void> {
		this.launches = await this.options.store.load(200)
		this.emit()
	}

	refresh(): Promise<void> {
		if (this.disposed) return Promise.resolve()
		if (this.polling) return this.polling
		this.polling = this.poll().finally(() => {
			this.polling = undefined
		})
		return this.polling
	}

	private async poll(): Promise<void> {
		clearTimeout(this.timer)
		let backoff = false
		try {
			await this.reload()
			for (const record of this.launches) {
				if (record.state === "dispatching" && this.now() - record.created > 5 * 60_000) {
					await this.options.store.update({
						...record,
						state: "unknown",
						error: "Dispatch was interrupted. Check the provider before launching again.",
					})
				}
			}
			const active = this.launches.filter(
				(record) => record.state === "accepted" && record.runId && record.run?.status !== "completed",
			)
			for (let offset = 0; offset < active.length && !this.disposed; offset += 4) {
				await Promise.all(
					active.slice(offset, offset + 4).map(async (record) => {
						try {
							const provider = this.options.providerFor(parseRemote(record.remoteUrl, record.provider))
							const rateLimitState = this.getRateLimitState(provider)
							if ((provider.rateLimitRemaining ?? 1000) < 100) {
								backoff = true
								const now = this.now()
								rateLimitState.lowSince ??= now
								if (
									now - rateLimitState.lowSince < 5 * 60_000 ||
									(rateLimitState.lastProbeTime !== undefined &&
										now - rateLimitState.lastProbeTime < 2 * 60_000)
								) {
									await this.options.store.update({
										...record,
										error: "Rate limit is low. Showing the last known status.",
									})
									return
								}
								// Reserve the probe before yielding so concurrent launches share one request.
								rateLimitState.lastProbeTime = now
							} else {
								rateLimitState.lowSince = undefined
								rateLimitState.lastProbeTime = undefined
							}
							const run = await provider.getRun(record.runId as number)
							await this.options.store.update({
								...record,
								run,
								url: run.url,
								updated: this.now(),
								error: undefined,
							})
						} catch {
							backoff = true
							await this.options.store
								.update({ ...record, error: "Status refresh failed. Showing the last known status." })
								.catch((error) => Logger.warn("[Pipelines] Failed to save status:", error))
						}
					}),
				)
			}
			await this.reload()
		} catch (error) {
			backoff = true
			Logger.warn("[Pipelines] Failed to refresh run history:", error)
		} finally {
			if (!this.disposed) {
				this.timer = setTimeout(() => void this.refresh(), (this.viewers ? 30_000 : 120_000) * (backoff ? 4 : 1))
				this.timer.unref?.()
			}
		}
	}

	dispose(): void {
		this.disposed = true
		clearTimeout(this.timer)
		this.listeners.clear()
	}
}
