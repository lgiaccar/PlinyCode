import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { lock } from "proper-lockfile"
import { Logger } from "@/shared/services/Logger"
import type { PipelineDefinition, PipelineRun } from "../server/providers/types"

export interface PipelineLaunch {
	id: string
	repoRoot: string
	remoteUrl: string
	provider: "github" | "ado"
	pipeline: PipelineDefinition
	ref: string
	revision: string
	created: number
	state: "dispatching" | "accepted" | "rejected" | "unknown"
	runId?: number
	url: string
	run?: PipelineRun
	updated?: number
	error?: string
}

const validId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)

export class PipelineRunStore {
	private readonly directory: string

	constructor(directory: string, workspace: string) {
		this.directory = path.join(directory, createHash("sha256").update(workspace).digest("hex"))
	}

	private file(id: string): string {
		if (!validId(id)) throw new Error("Invalid pipeline launch ID.")
		return path.join(this.directory, `${id}.json`)
	}

	async load(limit = 100): Promise<PipelineLaunch[]> {
		let files: string[]
		try {
			files = await fs.readdir(this.directory)
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
			throw error
		}
		
		// Filter and limit files to prevent unbounded reads
		const validFiles = files
			.filter((file) => file.endsWith(".json") && validId(file.slice(0, -5)))
			.slice(0, limit) // Limit the number of files to process
		
		// Process files in smaller batches to avoid unbounded I/O bursts
		const batchSize = 10
		const records: (PipelineLaunch | undefined)[] = []
		
		for (let i = 0; i < validFiles.length; i += batchSize) {
			const batch = validFiles.slice(i, i + batchSize)
			const batchRecords = await Promise.all(
				batch.map(async (file) => {
					try {
						return await this.get(file.slice(0, -5))
					} catch (error) {
						Logger.warn("[Pipelines] Could not read a launch record:", error)
						return undefined
					}
				}),
			)
			records.push(...batchRecords)
		}
		
		return records
			.filter((record): record is PipelineLaunch => record !== undefined)
			.sort((left, right) => right.created - left.created)
	}

	async get(id: string): Promise<PipelineLaunch | undefined> {
		try {
			const record = JSON.parse(await fs.readFile(this.file(id), "utf8")) as PipelineLaunch
			if (
				record.id !== id ||
				!["github", "ado"].includes(record.provider) ||
				!record.remoteUrl ||
				!record.repoRoot ||
				!record.pipeline?.id ||
				!record.ref ||
				!Number.isFinite(record.created) ||
				!["dispatching", "accepted", "rejected", "unknown"].includes(record.state)
			) {
				throw new Error("Invalid pipeline launch record.")
			}
			return record
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
			throw error
		}
	}

	async create(record: PipelineLaunch): Promise<boolean> {
		await fs.mkdir(this.directory, { recursive: true })
		const temp = `${this.file(record.id)}.${randomUUID()}.tmp`
		try {
			await fs.writeFile(temp, JSON.stringify(record), "utf8")
			await fs.link(temp, this.file(record.id))
			return true
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
			throw error
		} finally {
			await fs.rm(temp, { force: true })
		}
	}

	async update(record: PipelineLaunch): Promise<void> {
		const file = this.file(record.id)
		const release = await lock(file, {
			realpath: false,
			stale: 10_000,
			update: 3000,
			retries: { retries: 5, minTimeout: 20, maxTimeout: 100 },
		})
		const temp = `${file}.${randomUUID()}.tmp`
		try {
			const previous = await this.get(record.id)
			if (previous?.run?.status === "completed" && record.run?.status !== "completed") return
			if ((previous?.updated ?? 0) > (record.updated ?? 0)) return
			await fs.writeFile(temp, JSON.stringify(record), "utf8")
			await fs.rename(temp, file)
		} finally {
			await fs.rm(temp, { force: true })
			await release()
		}
	}
}
