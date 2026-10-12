import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CiBoardStore } from "../ci-board-store"
import { BUILTIN_IDS, defaultActions } from "../types"
import { boardTarget } from "./fake-board-provider"

const EMPTY = { targets: [], links: {}, autoAttempts: [], triage: {} }

describe("CiBoardStore", () => {
	let dir: string
	let file: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-board-store-"))
		file = path.join(dir, "data", "ci-board.json")
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("keeps each workspace's board apart", async () => {
		const store = new CiBoardStore(file)
		await store.update("/repo-a", (d) => ({ ...d, targets: [boardTarget({ id: "a", actions: defaultActions() })] }))
		await store.update("/repo-b", (d) => ({ ...d, targets: [boardTarget({ id: "b" })] }))
		expect((await store.load("/repo-a")).targets.map((t) => t.id)).toEqual(["a"])
		expect((await store.load("/repo-b")).targets.map((t) => t.id)).toEqual(["b"])
		expect(await store.load("/repo-c")).toEqual(EMPTY)
	})

	it("sees another window's writes, and serialises its own", async () => {
		const one = new CiBoardStore(file)
		const two = new CiBoardStore(file)
		await one.update("/repo", (d) => ({
			...d,
			links: { k1: { conversationId: "c1", actionId: "fix", worktree: "/w", startedTs: 1 } },
		}))
		await two.update("/repo", (d) => ({
			...d,
			links: { ...d.links, k2: { conversationId: "c2", actionId: "fix", worktree: "/w", startedTs: 2 } },
		}))
		await Promise.all([
			one.update("/repo", (d) => ({ ...d, targets: [...d.targets, boardTarget({ id: "x" })] })),
			one.update("/repo", (d) => ({ ...d, targets: [...d.targets, boardTarget({ id: "y" })] })),
		])
		const data = await one.load("/repo")
		expect(Object.keys(data.links)).toEqual(["k1", "k2"])
		expect(data.targets.map((t) => t.id)).toEqual(["x", "y"])
	})

	it("matches Windows paths without regard to case", async () => {
		const store = new CiBoardStore(file)
		await store.update("D:\\dev0\\Repo", (d) => ({ ...d, targets: [boardTarget()] }))
		expect((await store.load("d:\\dev0\\repo")).targets).toHaveLength(1)
	})

	it("reads a corrupt file or bad entries as empty", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		fs.writeFileSync(file, "{not json")
		expect(await new CiBoardStore(file).load("/repo")).toEqual(EMPTY)
		fs.writeFileSync(
			file,
			JSON.stringify({ boards: { "/repo": { targets: [{ id: "x" }, boardTarget()], links: { k: 3 } } } }),
		)
		const data = await new CiBoardStore(file).load("/repo")
		expect([data.targets.length, Object.keys(data.links)]).toEqual([1, []])
	})

	it("migrates a version 1 board: built-in actions, auto-watch off, custom actions kept", async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true })
		const v1Target = (id: string, actions: unknown[], autonomy = "full_auto") => ({
			...boardTarget({ id }),
			autoWatch: undefined,
			autonomy,
			actions,
		})
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				boards: {
					"/repo": {
						targets: [
							v1Target("default", [
								{
									id: "fix",
									label: "Fix CI & conflicts",
									prompt: { kind: "builtin" },
									trigger: "on_failure_or_conflict",
								},
							]),
							v1Target("custom", [
								{ id: "fix", label: "Make it green", prompt: { kind: "builtin" }, trigger: "manual" },
								{
									id: "deltas",
									label: "Pipeline deltas",
									prompt: { kind: "file", path: "AI_prompts/pipelines_failures_investigation.md" },
									trigger: "on_failure",
								},
							]),
						],
						links: {},
					},
				},
			}),
		)
		const data = await new CiBoardStore(file).load("/repo")
		const [plain, custom] = data.targets
		expect(plain.autoWatch).toBe(false)
		expect("autonomy" in plain).toBe(false)
		expect(plain.actions.map((a) => a.id)).toEqual([...BUILTIN_IDS])
		expect(plain.actions.find((a) => a.id === "fix-conflicts")).toMatchObject({
			auto: true,
			model: "free",
			situation: "conflict",
		})
		// A renamed default becomes Fix CI with its name; a prompt file is kept, with its trigger as its situation.
		expect(custom.actions.map((a) => [a.id, a.label])).toEqual([
			["fix-conflicts", "Fix conflicts"],
			["recalibrate", "Recalibrate"],
			["fix-ci", "Make it green"],
			["investigate", "Investigate"],
			["deltas", "Pipeline deltas"],
		])
		expect(custom.actions[4]).toMatchObject({ situation: "failure", model: "free", auto: false })
	})

	it("keeps auto-watch counters for a week and the triage without step details", async () => {
		const store = new CiBoardStore(file)
		const now = Date.now()
		await store.update("/repo", (d) => ({
			...d,
			autoAttempts: [
				{ key: "k|fix-conflicts|a", count: 1, lastTs: now },
				{ key: "k|recalibrate|b", count: 2, lastTs: now - 8 * 24 * 60 * 60 * 1000 },
			],
			triage: {
				k: {
					fingerprint: "f",
					itemKey: "k",
					status: "done",
					severity: "high",
					summary: "s",
					pipelines: [],
					conflict: true,
					recommended: ["fix-conflicts"],
					source: "model",
					analyzedTs: 1,
				},
			},
		}))
		const data = await store.load("/repo")
		expect(data.autoAttempts.map((a) => a.key)).toEqual(["k|fix-conflicts|a"])
		expect(data.triage.k.severity).toBe("high")
	})
})
