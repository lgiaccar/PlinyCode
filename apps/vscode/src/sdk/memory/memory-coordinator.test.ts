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
