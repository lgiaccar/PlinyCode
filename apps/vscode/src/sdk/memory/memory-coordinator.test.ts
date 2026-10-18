import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { parseMemoryProposal } from "@shared/memory-proposal"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GitRunner } from "../context/git-snapshot"
import { MemoryCoordinator, type MemoryCoordinatorDeps } from "./memory-coordinator"
import { buildDistillTranscript, hasSuccessfulEdit, parseDistillReply } from "./memory-distiller"
import { MemoryStore } from "./memory-store"

const REMOTE: GitRunner = async (args) =>
	args.join(" ") === "remote get-url origin"
		? { stdout: "https://github.com/org/repo\n", exitCode: 0 }
		: { stdout: "", exitCode: 128 }

const user = (text: string, metadata?: Record<string, unknown>) => ({ role: "user", content: [{ type: "text", text }], metadata })
const editCall = (id: string) => ({
	role: "assistant",
	content: [{ type: "tool_use", id, name: "editor", input: { path: "/work/a/src/x.ts" } }],
})
const toolResult = (id: string, isError = false) => ({
	role: "user",
	content: [{ type: "tool_result", tool_use_id: id, content: isError ? "failed" : "ok", is_error: isError }],
})
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] })

const EDITED = [user("make git log not hang"), editCall("t1"), toolResult("t1"), reply("Done: GIT_PAGER=cat.")]
const MODEL_REPLY = JSON.stringify({
	memories: [
		{ text: "git log hangs without --no-pager in agent terminals", scope: "repo", importance: "high" },
		{ text: "The user prefers short answers", scope: "user", importance: "normal" },
	],
})

describe("memory-distiller", () => {
	it("finds an edit that did not fail, in the last run only", () => {
		expect(hasSuccessfulEdit(EDITED)).toBe(true)
		expect(hasSuccessfulEdit([user("a"), editCall("t1"), toolResult("t1", true)])).toBe(false)
		expect(hasSuccessfulEdit([...EDITED, user("question"), reply("answer")], 4)).toBe(false)
	})

	it("renders a compact transcript without side questions", () => {
		const transcript = buildDistillTranscript([...EDITED, user("side?", { offTheRecord: true }), reply("side answer")])
		expect(transcript).toContain("USER: make git log not hang")
		expect(transcript).toContain("[editor /work/a/src/x.ts]")
		expect(transcript).not.toContain("side answer")
	})

	it("keeps the end of a long conversation", () => {
		const long = Array.from({ length: 400 }, (_, index) => reply(`step ${index} ${"y".repeat(100)}`))
		const transcript = buildDistillTranscript(long)
		expect(transcript.startsWith("[earlier messages cut]")).toBe(true)
		expect(transcript).toContain("step 399")
	})

	it("parses the reply and skips what the memory already has", () => {
		const parsed = parseDistillReply(`Sure!\n${MODEL_REPLY}`, "- The user prefers short answers")
		expect(parsed).toEqual([
			{ text: "git log hangs without --no-pager in agent terminals", scope: "repo", importance: "high" },
		])
		expect(parseDistillReply("no json here", "")).toEqual([])
	})

	it("compares whole entries, and skips what the user dismissed before", () => {
		const reply = JSON.stringify({
			memories: [
				{ text: "Use bun", scope: "repo" },
				{ text: "Run build:sdk after engine changes", scope: "repo" },
			],
		})
		// "Use bun" occurs inside a longer entry but is not one itself: it is new.
		const parsed = parseDistillReply(reply, "## Notes\n\n- Use bun, not npm, for every script")
		expect(parsed.map((memory) => memory.text)).toEqual(["Use bun", "Run build:sdk after engine changes"])
		// Dismissed before: not proposed again.
		expect(parseDistillReply(reply, "", new Set(["use bun"])).map((memory) => memory.text)).toEqual([
			"Run build:sdk after engine changes",
		])
	})

	it("drops proposals that record the task's changes or restate the code", () => {
		const reply = JSON.stringify({
			memories: [
				{ text: "Added FieldIsExpected helper to skip validation for missing baseline fields", scope: "repo" },
				{ text: "ExtractFaceBasedTetMesh takes local_num_surface as the third argument", scope: "repo" },
				{ text: "The pipeline fix in this PR only applies to manual triggers", scope: "repo" },
				{ text: "Python is not on PATH on this machine; use py.exe", scope: "user", importance: "high" },
				{ text: "a", scope: "repo" },
				{ text: "b", scope: "repo" },
				{ text: "c", scope: "repo" },
				{ text: "d", scope: "repo" },
			],
		})
		expect(parseDistillReply(reply, "").map((memory) => memory.text)).toEqual([
			"Python is not on PATH on this machine; use py.exe",
			"a",
			"b",
			"c",
		])
	})

	it("skips near duplicates of an entry and reports them as rediscovered", () => {
		const rediscovered: string[] = []
		const parsed = parseDistillReply(
			MODEL_REPLY,
			"## Notes\n\n- git log hangs without the no-pager flag in agent terminals <!-- added:2026-01-01 -->",
			new Set(),
			rediscovered,
		)
		expect(parsed.map((memory) => memory.text)).toEqual(["The user prefers short answers"])
		expect(rediscovered).toEqual(["git log hangs without --no-pager in agent terminals"])
	})
})

let root: string
beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), "plinycode-memory-"))
})
afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

function makeCoordinator(overrides: Partial<MemoryCoordinatorDeps> = {}) {
	const rows: ClineMessage[] = []
	let ts = 1000
	const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
	const deps: MemoryCoordinatorDeps = {
		store,
		emitRow: (message) => rows.push(message),
		nextMessageTs: () => ++ts,
		getDisplayedConversationId: () => "conv",
		readMessages: async () => EDITED,
		getCwd: async () => "/work/a",
		complete: vi.fn(async () => MODEL_REPLY),
		isOfferEnabled: () => true,
		isActMode: () => true,
		isBackgroundSession: () => false,
		...overrides,
	}
	return { coordinator: new MemoryCoordinator(deps), rows, deps, store }
}

const proposals = (rows: ClineMessage[]) =>
	rows.filter((row) => row.say === "memory_proposal").map((row) => ({ ts: row.ts, proposal: parseMemoryProposal(row.text) }))

describe("MemoryCoordinator", () => {
	it("offers memories after an act-mode run that edited files, and saves only the checked ones", async () => {
		const { coordinator, rows, store } = makeCoordinator()
		await coordinator.maybeOfferDistill("conv")

		const [offered] = proposals(rows)
		expect(offered.proposal?.status).toBe("pending")
		expect(offered.proposal?.items.map((item) => item.scope)).toEqual(["repo", "user"])
		// Nothing written yet.
		expect((await store.read("/work/a")).repoText).toBe("")

		await coordinator.resolveProposal(offered.proposal?.id ?? "", true, ["0"])
		const after = proposals(rows)
		const last = after[after.length - 1]
		expect(last.ts).toBe(offered.ts)
		expect(last.proposal?.status).toBe("saved")
		expect(last.proposal?.savedCount).toBe(1)
		const memory = await store.read("/work/a")
		expect(memory.repoText).toContain("git log hangs without --no-pager")
		expect(memory.userText).toBe("")
	})

	it("does not offer when the run edited nothing, in plan mode, in the background or for a side question", async () => {
		const cases: Array<Partial<MemoryCoordinatorDeps>> = [
			{ readMessages: async () => [user("question"), reply("answer")] },
			{ isActMode: () => false },
			{ isBackgroundSession: () => true },
			{ isOfferEnabled: () => false },
			{ getDisplayedConversationId: () => "other" },
			{ readMessages: async () => [...EDITED, user("side?", { offTheRecord: true }), reply("answer")] },
		]
		for (const overrides of cases) {
			const { coordinator, rows, deps } = makeCoordinator(overrides)
			await coordinator.maybeOfferDistill("conv")
			expect(rows).toEqual([])
			expect(deps.complete).not.toHaveBeenCalled()
		}
	})

	it("only distills what is new since the last offer", async () => {
		const { coordinator, deps } = makeCoordinator()
		await coordinator.maybeOfferDistill("conv")
		await coordinator.maybeOfferDistill("conv")
		expect(deps.complete).toHaveBeenCalledTimes(1)
	})

	it("remembers how far it distilled, and what the user dismissed, across a reload", async () => {
		const first = makeCoordinator()
		await first.coordinator.maybeOfferDistill("conv")
		const [offered] = proposals(first.rows)
		// Keep the first memory, leave the second unchecked.
		await first.coordinator.resolveProposal(offered.proposal?.id ?? "", true, ["0"])

		// A new window: nothing new in the conversation, so no model call.
		const second = makeCoordinator()
		await second.coordinator.maybeOfferDistill("conv")
		expect(second.deps.complete).not.toHaveBeenCalled()

		// /distill reads the whole conversation again, but the unchecked memory is
		// not proposed a second time and the saved one is already in memory.
		await second.coordinator.distillNow()
		expect(second.deps.complete).toHaveBeenCalledTimes(1)
		expect(proposals(second.rows)).toHaveLength(0)
		expect(second.rows.some((row) => (row.text ?? "").includes("No new memories"))).toBe(true)
	})

	it("keeps a pending proposal across a reload until it is resolved", async () => {
		const first = makeCoordinator()
		await first.coordinator.maybeOfferDistill("conv")
		const id = proposals(first.rows)[0].proposal?.id ?? ""

		// A new window: nothing in memory, the proposal comes back from disk.
		const second = makeCoordinator()
		await second.coordinator.showPending("conv")
		expect(proposals(second.rows)[0].proposal?.id).toBe(id)

		await second.coordinator.resolveProposal(id, false, [])
		expect(proposals(second.rows).pop()?.proposal?.status).toBe("dismissed")

		const third = makeCoordinator()
		await third.coordinator.showPending("conv")
		expect(third.rows).toEqual([])
	})

	it("/distill reports when nothing is worth keeping", async () => {
		const { coordinator, rows } = makeCoordinator({ complete: vi.fn(async () => '{"memories": []}') })
		await coordinator.distillNow()
		expect(rows.map((row) => row.text)).toContain("No new memories found in this conversation.")
	})

	it("proposes stale entries for removal on the same row and removes only the approved ones", async () => {
		const { coordinator, rows, store } = makeCoordinator({ complete: vi.fn(async () => '{"memories": []}') })
		const location = await store.locate("/work/a")
		await fs.mkdir(location.repoDir, { recursive: true })
		await fs.writeFile(
			location.repoFile,
			"# M\n\n## Notes\n\n- Stale one <!-- added:2000-01-01 -->\n- Stale two <!-- added:2000-01-02 -->\n",
		)
		await coordinator.distillNow()
		const [offered] = proposals(rows)
		expect(offered.proposal?.items).toEqual([
			{ id: "remove-0", scope: "repo", text: "Stale one", importance: "normal", action: "remove" },
			{ id: "remove-1", scope: "repo", text: "Stale two", importance: "normal", action: "remove" },
		])
		// Nothing removed before the user approves.
		expect(await fs.readFile(location.repoFile, "utf8")).toContain("Stale one")

		await coordinator.resolveProposal(offered.proposal?.id ?? "", true, ["remove-0"])
		const last = proposals(rows).pop()?.proposal
		expect(last?.status).toBe("saved")
		expect(last?.removedCount).toBe(1)
		const text = await fs.readFile(location.repoFile, "utf8")
		expect(text).not.toContain("Stale one")
		// The unchecked one is kept and counts as used, so it is not proposed again soon.
		expect(text).toMatch(/- Stale two <!-- added:2000-01-02 used:\d{4}-\d{2}-\d{2} -->/)
		expect(await store.pruneCandidates("/work/a")).toEqual([])
	})

	it("keeps every prune item when the proposal is dismissed", async () => {
		const { coordinator, rows, store } = makeCoordinator({ complete: vi.fn(async () => '{"memories": []}') })
		const location = await store.locate("/work/a")
		await fs.mkdir(location.repoDir, { recursive: true })
		await fs.writeFile(location.repoFile, "# M\n\n## Notes\n\n- Stale one <!-- added:2000-01-01 -->\n")
		await coordinator.distillNow()
		await coordinator.resolveProposal(proposals(rows)[0].proposal?.id ?? "", false, [])
		expect(await fs.readFile(location.repoFile, "utf8")).toMatch(/- Stale one <!-- added:2000-01-01 used:/)
	})

	it("removes the pending and distill files of deleted conversations, once per window", async () => {
		const listConversationIds = vi.fn(async () => ["live"])
		const { coordinator } = makeCoordinator({ listConversationIds })
		const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
		for (const dir of ["pending", "distill"]) {
			await fs.mkdir(path.join(root, dir), { recursive: true })
			for (const name of ["live", "deleted"]) {
				await fs.writeFile(path.join(root, dir, `${name}.json`), "{}")
				await fs.utimes(path.join(root, dir, `${name}.json`), old, old)
			}
		}
		// Changed today: its conversation may not be in the history yet.
		await fs.writeFile(path.join(root, "pending", "brand-new.json"), "{}")

		expect(await coordinator.pruneOrphanFiles()).toBe(2)
		expect((await fs.readdir(path.join(root, "pending"))).sort()).toEqual(["brand-new.json", "live.json"])
		expect(await fs.readdir(path.join(root, "distill"))).toEqual(["live.json"])

		// An empty listing proves nothing: nothing is deleted.
		const empty = makeCoordinator({ listConversationIds: async () => [] })
		await fs.utimes(path.join(root, "pending", "brand-new.json"), old, old)
		expect(await empty.coordinator.pruneOrphanFiles()).toBe(0)

		// Opening conversations runs it once in the background.
		listConversationIds.mockClear()
		const scheduled = makeCoordinator({ listConversationIds })
		await scheduled.coordinator.showPending("live")
		await scheduled.coordinator.showPending("live")
		expect(listConversationIds).toHaveBeenCalledTimes(1)
	})

	it("/distill reports a failed model call", async () => {
		const { coordinator, rows } = makeCoordinator({
			complete: vi.fn(async () => {
				throw new Error("gateway down")
			}),
		})
		await coordinator.distillNow()
		expect(rows.some((row) => row.text?.includes("gateway down"))).toBe(true)
	})
})
