import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { CoreSessionConfig } from "@plinycode/core"
import { memoryBudgetTokens, parseMemoryBudget } from "@shared/memory-budget"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GitRunner } from "../context/git-snapshot"
import { installSessionTrace } from "../trace/session-trace"
import { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import { installMemory } from "./install-memory"
import { MemoryCoordinator } from "./memory-coordinator"
import { parseDistillReply } from "./memory-distiller"
import { listMemoryEntries } from "./memory-file"
import { looksLikeChangeLog } from "./memory-quality"
import { rankMemories, selectMemories } from "./memory-retrieval"
import { MemoryStore } from "./memory-store"
import { createRecallMemoryTool } from "./memory-tools"
import { groupIdentity, repoKeyFromIdentity } from "./repo-key"

const remote =
	(url = "https://github.com/org/repo"): GitRunner =>
	async () => ({ stdout: url, exitCode: 0 })
let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), "pliny-memory-upgrades-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})
const store = () => new MemoryStore({ rootDir: root, runGit: remote(), now: () => new Date("2026-10-23T12:00:00Z") })

describe("memory upgrades", () => {
	it("rebudgets snapshots when switching to a smaller model", async () => {
		const memory = store()
		for (let index = 0; index < 25; index++)
			await memory.save("/repo", {
				scope: "repo",
				text: `Rule ${index}: ${"always preserve the pinned toolchain and baseline arguments ".repeat(5)}`,
				importance: "normal",
			})
		const snapshots = new ConversationMemorySnapshots({
			getMaxTokens: (window) => memoryBudgetTokens("auto", window ?? 32_000),
			read: (cwd) => memory.read(cwd),
		})
		const large = await snapshots.prepare("conv", "/repo", 200_000)
		large.bindToSession("conv")
		expect(snapshots.retrieve("conv", "toolchain")?.budget).toBe(4000)
		const small = await snapshots.prepare("conv", "/repo", 32_000)
		small.bindToSession("conv")
		const selected = snapshots.retrieve("conv", "toolchain")!
		expect(selected.budget).toBe(1280)
		expect(selected.summary.chars).toBeLessThanOrEqual(1280 * 3)
	})
	it("keeps retrieved and recently saved notes out of stale cleanup", async () => {
		const memory = store()
		const location = await memory.locate("/repo")
		await fs.mkdir(location.repoDir, { recursive: true })
		await fs.writeFile(location.repoFile, "## Notes\n- Conan gtest gotcha <!-- added:2000-01-01 -->\n")
		expect(await memory.pruneCandidates("/repo")).toHaveLength(1)
		await memory.recordUsage("/repo", "conv", await memory.entries("/repo"))
		expect(await memory.pruneCandidates("/repo")).toHaveLength(0)
		await memory.touch("/repo", ["Conan gtest gotcha"])
		expect(await memory.pruneCandidates("/repo")).toHaveLength(0)
	})

	it("corrects a memory with details and removes only the confirmed scope", async () => {
		const memory = store()
		await memory.save("/repo", { scope: "repo", text: "Always link Release gtest libraries", importance: "high" })
		const replaced = await memory.save("/repo", {
			scope: "repo",
			text: "Always link Release gtest libraries for Debug",
			importance: "high",
			replace: true,
			details: "Debug needs the Release import library",
			topic: "debug",
		})
		expect(replaced.replaced).toBe(true)
		expect(await fs.readFile(replaced.topicFile!, "utf8")).toContain("Debug needs")
		const location = await memory.locate("/repo")
		await fs.mkdir(location.userDir, { recursive: true })
		await fs.writeFile(location.userFile, "## Notes\n- Always link Release gtest libraries for Debug\n")
		await memory.save("/repo", {
			scope: "user",
			text: "Always link Release gtest libraries for Debug",
			importance: "normal",
			remove: true,
		})
		expect((await memory.read("/repo")).repoText).toContain("gtest libraries for Debug")
		expect((await memory.read("/repo")).userText).not.toContain("gtest")
	})

	it("expires old inbox records and notices resolution in another window", async () => {
		const memory = store()
		const makeCoordinator = () =>
			new MemoryCoordinator({
				store: memory,
				emitRow: vi.fn(),
				nextMessageTs: () => 1,
				getDisplayedConversationId: () => "conv",
				getCwd: async () => "/repo",
				readMessages: async () => [],
				complete: async () => "",
				isOfferEnabled: () => true,
				isActMode: () => false,
				isBackgroundSession: () => false,
			})
		const dir = path.join(root, "pending")
		await fs.mkdir(dir, { recursive: true })
		const write = (id: string, age: number) =>
			fs.writeFile(
				path.join(dir, `${id}.json`),
				JSON.stringify({
					cwd: "/repo",
					proposal: {
						id,
						conversationId: id,
						createdAt: Date.now() - age * 24 * 60 * 60 * 1000,
						status: "pending",
						items: [{ id: "0", scope: "repo", importance: "normal", text: "Use the simple workflow" }],
					},
				}),
			)
		await write("old", 31)
		await write("live", 1)
		const first = makeCoordinator()
		const second = makeCoordinator()
		expect((await first.inbox("/repo")).map((proposal) => proposal.id)).toEqual(["live"])
		await second.inbox("/repo")
		await second.resolveProposal("live", false, [])
		expect(await first.inbox("/repo")).toEqual([])
	})

	it("records selection IDs and tiers in the session trace", async () => {
		const memory = store()
		await memory.save("/repo", { scope: "repo", text: "Conan gtest Debug needs Release libraries", importance: "normal" })
		const selected = selectMemories(await memory.read("/repo"), 1280, "gtest")
		const dir = path.join(root, "traces")
		const trace = installSessionTrace({ sessionId: "conv" } as CoreSessionConfig, { enabled: () => true, dir })
		trace.recordMemory(selected)
		await trace.flush()
		const record = JSON.parse((await fs.readFile(path.join(dir, "conv.jsonl"), "utf8")).trim())
		expect(record).toMatchObject({
			type: "memory",
			budget: 1280,
			loaded: [{ id: selected.loaded[0].entry.id, tier: "retrieved" }],
		})
		expect(record.estimatedTokens).toBeLessThanOrEqual(1280)
	})

	it("keeps 350-character proposals and preserves overflow in details", async () => {
		const full = `Always use the documented workflow ${"carefully ".repeat(90)}and preserve the crucial final argument --release-debug.`
		const text = `Use ${"x".repeat(346)}`
		expect(parseDistillReply(JSON.stringify({ memories: [{ text }] }), "")[0].text).toBe(text)
		const [proposal] = parseDistillReply(JSON.stringify({ memories: [{ text: full, type: "gotcha" }] }), "")
		expect(proposal.details).toBe(full)
		const result = await store().save("/repo", proposal)
		expect(await fs.readFile(result.topicFile!, "utf8")).toContain(full)
	})

	it("deduplicates across scopes and keeps shared details", async () => {
		const memory = store()
		await memory.save("/repo", {
			scope: "group",
			text: "Always link Release gtest libraries for Debug builds",
			importance: "high",
			type: "gotcha",
		})
		const result = await memory.save("/repo", {
			scope: "repo",
			text: "Always link Release gtest libraries for Debug builds",
			importance: "high",
			details: "The generator emits Release targets only.",
			topic: "gtest",
		})
		expect(result.inserted).toBe(false)
		expect(result.file).toContain(`${path.sep}groups${path.sep}`)
		const content = await memory.read("/repo")
		expect(content.repoText).toBe("")
		expect(content.groupText).toContain("details: gtest.md")
		expect(await fs.readFile(result.topicFile!, "utf8")).toContain("Release targets only")
	})

	it("persists the save cap across windows and keeps coordinator state", async () => {
		const memory = store()
		await memory.updateState("conversation", { upTo: 42, dismissed: ["old"] })
		for (let index = 0; index < 8; index++)
			await store().save("/repo", {
				scope: "repo",
				text: `Reference ${index}`,
				importance: "normal",
				conversationId: "conversation",
			})
		expect(
			(
				await store().save("/repo", {
					scope: "user",
					text: "Extra fact",
					importance: "normal",
					conversationId: "conversation",
				})
			).rejected,
		).toBe("conversation-cap")
		await memory.updateState("conversation", { upTo: 50 })
		expect(JSON.parse(await fs.readFile(memory.stateFile("conversation"), "utf8"))).toMatchObject({
			saveCount: 8,
			upTo: 50,
			dismissed: ["old"],
		})
	})

	it("refuses task narratives disguised as Important rules", () => {
		expect(
			looksLikeChangeLog(
				"When resolving merge conflicts between a branch adding a process-killing wrapper script and stage adding extra build targets, keep both intents.",
			),
		).toBe(true)
		expect(
			looksLikeChangeLog(
				"When instrumenting Triangulate() in SurfaceTetMesh.cxx, remember there are two end_phase lambdas.",
			),
		).toBe(true)
		expect(looksLikeChangeLog("When updating Conan, always use the Release gtest libraries for Debug.")).toBe(false)
	})

	it("derives GitHub/ADO groups and respects overrides", async () => {
		for (const [identity, expected] of [
			["github.com/org/repo", "github.com/org"],
			["dev.azure.com/org/project/_git/repo", "dev.azure.com/org/project"],
			["ado.internal.synopsys.com/tfs/collection/project/_git/repo", "ado.internal.synopsys.com/tfs/collection/project"],
		])
			expect(groupIdentity({ kind: "remote", identity, key: "key" })).toBe(expected)
		const location = await store().locate("/repo")
		await fs.mkdir(location.repoDir, { recursive: true })
		await fs.writeFile(path.join(location.repoDir, "repo.json"), JSON.stringify({ group: "custom/group" }))
		expect((await store().locate("/repo")).group).toBe("custom/group")
	})

	it("adopts old-host memory through a persistent alias", async () => {
		const previous = new MemoryStore({ rootDir: root, runGit: remote("https://old.example/org/repo") })
		await previous.save("/repo", { scope: "repo", text: "Use the shared Conan profile", importance: "normal" })
		const current = new MemoryStore({ rootDir: root, runGit: remote("https://new.example/org/repo") })
		const key = repoKeyFromIdentity("old.example/org/repo")
		expect(await current.adoptionCandidates("/repo")).toContainEqual({ key, identity: "old.example/org/repo" })
		await current.adopt("/repo", key)
		expect((await current.read("/repo")).repoText).toContain("Conan profile")
		const reopened = new MemoryStore({ rootDir: root, runGit: remote("https://new.example/org/repo") })
		expect((await reopened.read("/repo")).repoText).toContain("Conan profile")
	})

	it("moves entries without losing dates, pins or details", async () => {
		const memory = store()
		await memory.save("/repo", {
			scope: "repo",
			text: "Always link Release gtest",
			importance: "high",
			type: "gotcha",
			details: "Need this for Debug",
			topic: "gtest",
		})
		let [entry] = await memory.entries("/repo")
		await memory.edit("/repo", entry.id, { pinned: true })
		await memory.move("/repo", entry.id, "group")
		;[entry] = await memory.entries("/repo")
		expect(entry).toMatchObject({ scope: "group", pinned: true, type: "gotcha", added: "2026-10-23" })
		const file = memory.fileFor(await memory.locate("/repo"), "group")
		expect(await fs.readFile(path.join(path.dirname(file), entry.topicFile!), "utf8")).toContain("Need this for Debug")
	})

	it("enables memory mid-conversation and freezes its system tier", async () => {
		const memory = store()
		await memory.save("/repo", { scope: "repo", text: "Always target stage for PRs", importance: "high" })
		await memory.save("/repo", { scope: "group", text: "Conan gtest Debug needs Release libraries", importance: "normal" })
		let budget = 0
		const snapshots = new ConversationMemorySnapshots({ getMaxTokens: () => budget, read: (cwd) => memory.read(cwd) })
		const off = await snapshots.prepare("conv", "/repo")
		off.bindToSession("conv")
		expect(off.section).toBeUndefined()
		budget = 4000
		const on = await snapshots.prepare("conv", "/repo")
		on.bindToSession("conv")
		expect(on.section).toContain("Always target stage")
		expect(on.section).not.toContain("Conan gtest")
		const selected = snapshots.retrieve("conv", "gtest Debug")!
		expect(selected.text).toBe(on.section)
		expect(selected.relevant).toContain("Conan gtest")
		const recall = createRecallMemoryTool({ store: memory, getCwd: () => "/repo" })
		expect(await recall.execute({ query: "gtest" }, { sessionId: "conv" } as never)).toContain("Conan gtest")
		await memory.recordUsage(
			"/repo",
			"conv",
			selected.loaded.filter((item) => item.tier === "retrieved").map((item) => item.entry),
		)
		expect(Object.values(await memory.usage("/repo"))[0].count).toBe(1)
	})

	it("uses model-relative budgets and ranks relevance above recency", async () => {
		expect(memoryBudgetTokens("auto", 32_000)).toBe(1280)
		expect(memoryBudgetTokens("auto", 200_000)).toBe(4000)
		expect(memoryBudgetTokens("4%", 32_000)).toBe(1280)
		expect(parseMemoryBudget("100001")).toBeUndefined()
		expect(parseMemoryBudget("101%")).toBeUndefined()
		const entries = listMemoryEntries(
			"## Notes\n- CUDA pipeline <!-- added:2026-10-23 -->\n- Conan gtest Debug libraries <!-- added:2025-01-01 -->",
			"repo",
		)
		expect(rankMemories(entries, "gtest")[0].text).toContain("Conan")
		const memory = store()
		for (const entry of entries) await memory.save("/repo", entry)
		const selected = selectMemories(await memory.read("/repo"), 1280, "gtest")
		expect(selected.summary.chars).toBeLessThanOrEqual(1280 * 3)
		expect(selected.relevant).toContain("gtest")
	})

	it("injects retrieval into the first user message and leaves the prompt unchanged", async () => {
		const memory = store()
		await memory.save("/repo", { scope: "repo", text: "Conan gtest Debug needs Release libraries", importance: "normal" })
		const snapshots = new ConversationMemorySnapshots({ getMaxTokens: () => 4000, read: (cwd) => memory.read(cwd) })
		const prepared = await snapshots.prepare("conv", "/repo")
		prepared.bindToSession("conv")
		const config = { sessionId: "conv", systemPrompt: `Base${prepared.section}` } as CoreSessionConfig
		installMemory(config, "/repo", {
			store: memory,
			search: {} as never,
			isMemoryEnabled: () => true,
			isSearchEnabled: () => false,
			selection: snapshots,
		})
		const messages = [{ role: "user", content: [{ type: "text", text: "Fix gtest" }] }]
		const output = await config.hooks?.beforeModel?.({ snapshot: {}, request: { messages } } as never)
		expect(JSON.stringify(output?.messages?.[0].content)).toContain("<relevant_memories>")
		expect(config.systemPrompt).toBe(`Base${prepared.section}`)
		expect(JSON.stringify(messages)).not.toContain("<relevant_memories>")
	})

	it("offers plan decisions, auto-saves normal proposals and persists Undo", async () => {
		const memory = store()
		const deps = {
			store: memory,
			emitRow: vi.fn(),
			nextMessageTs: () => 1,
			getDisplayedConversationId: () => "conv",
			readMessages: async () => [
				{ role: "user", content: [{ type: "text", text: "Choose a workflow" }] },
				{ role: "assistant", content: [{ type: "text", text: "Use the simple workflow" }] },
			],
			getCwd: async () => "/repo",
			complete: vi.fn(async () =>
				JSON.stringify({
					memories: [
						{
							text: "Use the simple workflow because the user chose clarity",
							importance: "normal",
							type: "decision",
						},
						{ text: "Never merge without CI", importance: "high", type: "convention" },
					],
				}),
			),
			isOfferEnabled: () => true,
			isActMode: () => false,
			isBackgroundSession: () => false,
			distillMode: () => "auto" as const,
		}
		const coordinator = new MemoryCoordinator(deps)
		await coordinator.maybeOfferDistill("conv")
		expect(deps.complete).toHaveBeenCalled()
		expect((await memory.entries("/repo")).map((entry) => entry.text)).toEqual([
			"Use the simple workflow because the user chose clarity",
		])
		const reloaded = new MemoryCoordinator(deps)
		const [proposal] = await reloaded.inbox("/repo")
		expect(proposal.items[0].autoSaved).toBe(true)
		await reloaded.undo(proposal.id, proposal.items[0].id)
		expect(await memory.entries("/repo")).toEqual([])
		expect((await reloaded.inbox("/repo"))[0].items[0].autoSaved).toBe(false)
	})
})
