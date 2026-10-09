import { afterEach, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DevOpsError } from "../server/errors"
import type { PipelineDispatch, PipelineProvider } from "../server/providers/types"
import type { RepoContext } from "../server/repo"
import { PipelineManager } from "./pipeline-manager"
import { PipelineRunStore } from "./pipeline-run-store"

const managers: PipelineManager[] = []
const directories: string[] = []
afterEach(async () => {
	for (const manager of managers.splice(0)) manager.dispose()
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function setup(
	queue: () => Promise<PipelineDispatch> = async () => ({ runId: 42, url: "https://github.com/o/r/actions/runs/42" }),
	polling?: { now: () => number; remaining: number; status: string },
) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pipeline-test-"))
	directories.push(directory)
	const store = new PipelineRunStore(directory, "/workspace")
	let dispatches = 0
	let polls = 0
	const provider = {
		kind: "github",
		get rateLimitRemaining() {
			return polling?.remaining ?? 1000
		},
		repoUrl: "https://github.com/o/r",
		listPipelines: async () => [{ id: 1, name: "Build", url: "https://github.com/o/r/actions" }],
		pipelineInputs: async () => ({ revision: "sha", inputs: [], limitations: [] }),
		queuePipeline: async () => {
			dispatches++
			return queue()
		},
		getRun: async () => {
			polls++
			return {
				id: 42,
				pipelineId: 1,
				name: "Build",
				branch: "main",
				event: "workflow_dispatch",
				status: polling?.status ?? "completed",
				result: "success",
				url: "https://github.com/o/r/actions/runs/42",
				started: new Date().toISOString(),
			}
		},
	} as unknown as PipelineProvider
	const options = {
		store,
		now: polling?.now,
		repositories: async () => ["/workspace"],
		providerFor: () => provider,
		loadRepo: async () =>
			({
				root: "/workspace",
				remoteUrl: "https://github.com/o/r.git",
				remote: { kind: "github", host: "github.com", owner: "o", repo: "r" },
			}) as RepoContext,
	}
	const manager = new PipelineManager(options)
	managers.push(manager)
	await manager.init()
	return {
		manager,
		store,
		options,
		counts: () => ({ dispatches, polls }),
		request: { id: randomUUID(), repoRoot: "/workspace", pipelineId: 1, ref: "main", revision: "sha", inputs: {} },
	}
}

describe("pipeline launches", () => {
	it("waits five minutes before probing a newly low rate limit", async () => {
		let now = 10 * 60_000
		const polling = { now: () => now, remaining: 99, status: "in_progress" }
		const { manager, request, counts } = await setup(undefined, polling)
		await manager.queue(request)
		await manager.refresh()
		expect(counts().polls).toBe(0)
		now += 5 * 60_000 - 1
		await manager.refresh()
		expect(counts().polls).toBe(0)
		now++
		await manager.refresh()
		expect(counts().polls).toBe(1)
	})

	it("repeats low-rate probes every two minutes, not every five minutes", async () => {
		let now = 0
		const polling = { now: () => now, remaining: 99, status: "in_progress" }
		const { manager, request, counts } = await setup(undefined, polling)
		await manager.queue(request)
		await manager.refresh()
		now = 5 * 60_000 + 1
		await manager.refresh()
		expect(counts().polls).toBe(1)
		now += 2 * 60_000 - 1
		await manager.refresh()
		expect(counts().polls).toBe(1)
		now++
		await manager.refresh()
		expect(counts().polls).toBe(2)
	})

	it("allows only one low-rate probe per repository across concurrent launches", async () => {
		let now = 10 * 60_000
		const polling = { now: () => now, remaining: 99, status: "in_progress" }
		const { manager, request, counts } = await setup(undefined, polling)
		await Promise.all([manager.queue(request), manager.queue({ ...request, id: randomUUID() })])
		await manager.refresh()
		expect(counts().polls).toBe(0)
		now += 5 * 60_000
		await manager.refresh()
		expect(counts().polls).toBe(1)
	})

	it("resumes normal polling after the rate limit recovers", async () => {
		let now = 0
		const polling = { now: () => now, remaining: 99, status: "in_progress" }
		const { manager, request, counts, store } = await setup(undefined, polling)
		await manager.queue(request)
		await manager.refresh()
		expect((await store.get(request.id))?.error).toContain("Rate limit")
		polling.remaining = 100
		await manager.refresh()
		expect(counts().polls).toBe(1)
		expect((await store.get(request.id))?.error).toBeUndefined()
		now += 30_000
		await manager.refresh()
		expect(counts().polls).toBe(2)
	})

	it("limits history by launch time rather than UUID filename order", async () => {
		const { manager, request, store } = await setup()
		await manager.queue(request)
		await manager.refresh()
		const record = await store.get(request.id)
		if (!record) throw new Error("Missing test record")
		await store.create({ ...record, id: "00000000-0000-4000-8000-000000000001", created: 1 })
		await store.create({ ...record, id: "ffffffff-ffff-4fff-8fff-ffffffffffff", created: record.created + 1 })
		expect((await store.load(1)).map((launch) => launch.id)).toEqual(["ffffffff-ffff-4fff-8fff-ffffffffffff"])
	})

	it("retains all unfinished launches beyond the finished history limit", async () => {
		const { manager, request, store } = await setup()
		await manager.queue(request)
		await manager.refresh()
		const record = await store.get(request.id)
		if (!record) throw new Error("Missing test record")
		const unfinished = [
			{ ...record, id: randomUUID(), created: 1, run: undefined },
			{ ...record, id: randomUUID(), created: 2, run: undefined, runId: undefined },
			{ ...record, id: randomUUID(), created: 3, run: undefined, runId: undefined, state: "unknown" as const },
			{ ...record, id: randomUUID(), created: 4, run: undefined, runId: undefined, state: "dispatching" as const },
		]
		for (const launch of unfinished) await store.create(launch)
		await store.create({ ...record, id: randomUUID(), created: record.created + 1 })
		const history = await store.load(1)
		expect(history).toHaveLength(5)
		for (const launch of unfinished) expect(history.some((entry) => entry.id === launch.id)).toBe(true)
	})

	it("persists intent, dispatches once per request, polls by ID and stops at completion", async () => {
		const setupResult = await setup()
		const { manager, request, store, counts } = setupResult
		await Promise.all([manager.queue(request), manager.queue(request)])
		await manager.refresh()
		await manager.queue(request)
		await manager.refresh()
		expect(counts()).toEqual({ dispatches: 1, polls: 1 })
		expect((await store.get(request.id))?.run?.result).toBe("success")
		expect(JSON.stringify(await store.load(100))).not.toContain('"inputs"')
	})

	it("does not retry unknown dispatch outcomes", async () => {
		const { manager, request, store, counts } = await setup(async () => {
			throw new Error("connection lost")
		})
		expect((await manager.queue(request)).state).toBe("unknown")
		await manager.queue(request)
		expect(counts().dispatches).toBe(1)
		expect((await store.get(request.id))?.error).toContain("before launching again")
	})

	it("marks permission rejection separately", async () => {
		const { manager, request } = await setup(async () => {
			throw new DevOpsError("token or input should not be persisted", 403)
		})
		const record = await manager.queue(request)
		expect(record.state).toBe("rejected")
		expect(record.error).toContain("403")
		expect(record.error).not.toContain("token or input")
	})

	it("validates workspace and schema revision before queueing", async () => {
		const { manager, request, counts } = await setup()
		await expect(manager.queue({ ...request, repoRoot: "/other" })).rejects.toThrow("current workspace")
		await expect(manager.queue({ ...request, revision: "old" })).rejects.toThrow("changed")
		expect(counts().dispatches).toBe(0)
	})

	it("does not lose simultaneous launches from different store instances", async () => {
		const { manager, request, store, options } = await setup()
		const other = new PipelineManager({ ...options, store: new PipelineRunStore(directories[0], "/workspace") })
		managers.push(other)
		await other.init()
		await Promise.all([manager.queue(request), other.queue({ ...request, id: randomUUID() })])
		expect(await store.load(100)).toHaveLength(2)
	})

	it("uses a durable reservation to prevent duplicate dispatch across windows", async () => {
		const { manager, request, options, counts } = await setup()
		const other = new PipelineManager({ ...options, store: new PipelineRunStore(directories[0], "/workspace") })
		managers.push(other)
		await other.init()
		await Promise.all([manager.queue(request), other.queue(request)])
		expect(counts().dispatches).toBe(1)
	})

	it("leaves unidentified dispatches unguessed and validates explicit run association", async () => {
		const { manager, request, store } = await setup(async () => ({ url: "https://github.com/o/r/actions" }))
		const record = await manager.queue(request)
		expect(record.state).toBe("accepted")
		expect(record.runId).toBeUndefined()
		await manager.associate(record.id, 42)
		expect((await store.get(record.id))?.runId).toBe(42)
	})

	it("recovers interrupted dispatches without redispatching on restart", async () => {
		const { manager, request, store, options, counts } = await setup()
		await manager.queue(request)
		const record = await store.get(request.id)
		if (!record) throw new Error("Missing test record")
		await store.update({
			...record,
			created: Date.now() - 10 * 60_000,
			state: "dispatching",
			runId: undefined,
			run: undefined,
		})
		const restarted = new PipelineManager(options)
		managers.push(restarted)
		await restarted.init()
		expect((await store.get(request.id))?.state).toBe("unknown")
		expect(counts().dispatches).toBe(1)
	})

	it("recovers a stale update lock left by a crashed process", async () => {
		const { manager, request, store } = await setup(async () => ({ url: "https://github.com/o/r/actions" }))
		await manager.queue(request)
		const entries = await fs.readdir(directories[0])
		const file = path.join(directories[0], entries[0], `${request.id}.json`)
		await fs.mkdir(`${file}.lock`)
		const past = new Date(Date.now() - 60_000)
		await fs.utimes(`${file}.lock`, past, past)
		const record = await store.get(request.id)
		if (!record) throw new Error("Missing test record")
		await store.update({ ...record, error: "Recovered" })
		expect((await store.get(request.id))?.error).toBe("Recovered")
	})

	it("does not persist credentials embedded in the git remote URL", async () => {
		const { request, store, options } = await setup()
		const ctx = await options.loadRepo()
		const manager = new PipelineManager({
			...options,
			loadRepo: async () => ({ ...ctx, remoteUrl: "https://sensitive-token@github.com/o/r.git" }),
		})
		managers.push(manager)
		await manager.init()
		await manager.queue(request)
		await manager.queue(request)
		expect(JSON.stringify(await store.load(100))).not.toContain("sensitive-token")
		expect((await store.get(request.id))?.remoteUrl).toBe("https://github.com/o/r")
	})
})
