import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { CHARS_PER_TOKEN } from "@plinycode/shared"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { GitRunner } from "../context/git-snapshot"
import { ConversationMemorySnapshots } from "./conversation-memory-snapshots"
import { renderMemorySection } from "./memory-section"
import { MemoryStore, topicFileName, withFileLock } from "./memory-store"
import { createSaveMemoryTool, parseSaveMemoryInput } from "./memory-tools"

const REMOTE: GitRunner = async (args) =>
	args.join(" ") === "remote get-url origin"
		? { stdout: "git@github.com:org/repo.git\n", exitCode: 0 }
		: { stdout: "", exitCode: 128 }

let root: string

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(tmpdir(), "plinycode-memory-"))
})

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true })
})

describe("MemoryStore", () => {
	it("keeps repository memory under the repo key and personal memory apart", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const repo = await store.save("/work/a", { scope: "repo", text: "Use bun", importance: "normal" })
		const user = await store.save("/work/a", { scope: "user", text: "Answer briefly", importance: "high" })

		expect(path.dirname(repo.file)).toMatch(/repos[\\/]org-repo-[0-9a-f]{8}$/)
		expect(user.file).toBe(path.join(root, "user", "MEMORY.md"))
		expect(await fs.readFile(repo.file, "utf8")).toContain("- Use bun")
		expect(await fs.readFile(user.file, "utf8")).toContain("## Important\n\n- Answer briefly")
		const note = JSON.parse(await fs.readFile(path.join(path.dirname(repo.file), "repo.json"), "utf8"))
		expect(note).toEqual({ identity: "github.com/org/repo", kind: "remote", remote: "git@github.com:org/repo.git" })
	})

	it("serializes concurrent saves to one file", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				store.save("/work/a", { scope: "repo", text: `fact ${index}`, importance: "normal" }),
			),
		)
		const content = await store.read("/work/a")
		for (let index = 0; index < 10; index++) {
			expect(content.repoText).toContain(`- fact ${index}\n`)
		}
	})

	it("does not lose an entry when two windows save to one file at once", async () => {
		// Two stores stand for two VS Code windows: separate queues, one file.
		const first = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const second = new MemoryStore({ rootDir: root, runGit: REMOTE })
		await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				(index % 2 === 0 ? first : second).save("/work/a", {
					scope: "repo",
					text: `window fact ${index}`,
					importance: "normal",
				}),
			),
		)
		const content = await first.read("/work/a")
		for (let index = 0; index < 8; index++) {
			expect(content.repoText).toContain(`- window fact ${index}\n`)
		}
		const files = await fs.readdir(path.dirname(content.location.repoFile))
		expect(files.some((name) => name.endsWith(".lock"))).toBe(false)
	})

	it("breaks a lock left by a window that died mid-write", async () => {
		const file = path.join(root, "stale", "MEMORY.md")
		await fs.mkdir(path.dirname(file), { recursive: true })
		await fs.writeFile(`${file}.lock`, "")
		const old = new Date(Date.now() - 60_000)
		await fs.utimes(`${file}.lock`, old, old)
		const started = Date.now()
		expect(await withFileLock(file, async () => "ran")).toBe("ran")
		expect(Date.now() - started).toBeLessThan(1_500)
	})

	it("writes details to a topic file and lists it", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const result = await store.save("/work/a", {
			scope: "repo",
			text: "The release has three steps",
			importance: "normal",
			topic: "Release steps",
			details: "1. tick\n2. build\n3. publish",
		})
		expect(result.topicFile).toBeDefined()
		expect(await fs.readFile(result.topicFile ?? "", "utf8")).toBe("# Release steps\n\n1. tick\n2. build\n3. publish\n")
		const content = await store.read("/work/a")
		expect(content.repoText).toContain("(details: release-steps.md)")
		expect(content.repoTopics).toEqual([{ path: result.topicFile, summary: "Release steps" }])
	})

	it("reports a duplicate without writing it twice", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		await store.save("/work/a", { scope: "repo", text: "Use bun", importance: "normal" })
		const again = await store.save("/work/a", { scope: "repo", text: "use bun", importance: "high" })
		expect(again.inserted).toBe(false)
	})

	it("creates an empty memory file from the template", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const file = await store.ensureFile("/work/a", "repo")
		expect(await fs.readFile(file, "utf8")).toBe("# Repository memory: github.com/org/repo\n\n## Important\n\n## Notes\n")
	})
})

describe("topicFileName", () => {
	it("makes a safe file name and refuses MEMORY", () => {
		expect(topicFileName("Build quirks!")).toBe("build-quirks.md")
		expect(topicFileName("../../etc/passwd")).toBe("etc-passwd.md")
		expect(topicFileName("memory.md")).toBeUndefined()
	})
})

describe("renderMemorySection", () => {
	it("gives the user memory at most a quarter of the budget and the repository the rest", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		for (let index = 0; index < 40; index++) {
			await store.save("/work/a", { scope: "user", text: `personal preference number ${index}`, importance: "normal" })
			await store.save("/work/a", { scope: "repo", text: `repository fact number ${index}`, importance: "normal" })
		}
		const maxTokens = 700
		const section = renderMemorySection(await store.read("/work/a"), maxTokens)
		expect(section).toBeDefined()
		const text = section?.text ?? ""
		expect(text.startsWith("\n\n# Memory\n")).toBe(true)
		// The whole section, instructions included, stays within the budget; only the
		// two headings with their file paths come on top.
		expect(text.length).toBeLessThanOrEqual(maxTokens * CHARS_PER_TOKEN + 400)
		const userPart = text.slice(text.indexOf("## Your memory"))
		const repoPart = text.slice(text.indexOf("## Repository memory"), text.indexOf("## Your memory"))
		expect(userPart.length).toBeLessThan(repoPart.length)
		// Notes are newest first, so the budget keeps the latest and drops the oldest.
		expect(text).toContain("repository fact number 39")
		expect(text).not.toContain("repository fact number 0\n")
		expect(text).toMatch(/\[\d+ more entries are in `[^`]+MEMORY\.md`/)
		// The files' titles are dropped and their sections sit below the part's heading.
		expect(text).not.toContain("Repository memory: github.com/org/repo")
		expect(text).toContain("\n### Notes\n")
		// The user memory has no important entries: its empty section is left out.
		expect(userPart).not.toContain("### Important")
	})

	it("is off at 0 tokens and still explains saving when memory is empty", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		expect(renderMemorySection(await store.read("/work/a"), 0)).toBeUndefined()
		const empty = renderMemorySection(await store.read("/work/a"), 4000)
		expect(empty?.text).toContain("save_memory")
		expect(empty?.text).toContain("(empty)")
		expect(empty?.summary.entries).toBe(0)
	})
})

describe("ConversationMemorySnapshots", () => {
	it("reads the files once per conversation, so a save mid-conversation does not change its prompt", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		await store.save("/work/a", { scope: "repo", text: "first fact", importance: "normal" })
		const snapshots = new ConversationMemorySnapshots({ getMaxTokens: () => 4000, read: (cwd) => store.read(cwd) })

		const started = await snapshots.prepare(undefined, "/work/a")
		started.bindToSession("conv-1")
		await store.save("/work/a", { scope: "repo", text: "second fact", importance: "normal" })

		const rebuilt = await snapshots.prepare("conv-1", "/work/a")
		expect(rebuilt.section).toBe(started.section)
		expect(rebuilt.section).not.toContain("second fact")

		const next = await snapshots.prepare(undefined, "/work/a")
		expect(next.section).toContain("second fact")
	})

	it("shows nothing while the budget is 0", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const snapshots = new ConversationMemorySnapshots({ getMaxTokens: () => 0, read: (cwd) => store.read(cwd) })
		expect((await snapshots.prepare(undefined, "/work/a")).section).toBeUndefined()
	})
})

describe("save_memory", () => {
	it("accepts what models send", () => {
		expect(parseSaveMemoryInput({ memory: "x", scope: "global", important: true })).toEqual({
			scope: "user",
			text: "x",
			importance: "high",
			topic: undefined,
			details: undefined,
		})
		expect(parseSaveMemoryInput({ text: "y", importance: "low" }).importance).toBe("normal")
		expect(() => parseSaveMemoryInput({})).toThrow(/Nothing to save/)
	})

	it("saves and says where", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		const tool = createSaveMemoryTool({ store, getCwd: () => "/work/a", getMaxTokens: () => 4000 })
		const context = { agentId: "a", iteration: 1 }
		expect(await tool.execute({ text: "Use bun", importance: "high" }, context)).toMatch(
			/^Saved to .*at the top of Important\. Later conversations will see it\./,
		)
		expect(await tool.execute({ text: "Prefer vitest" }, context)).toMatch(
			/at the top of Notes\. Later conversations will see it\./,
		)
		expect(await tool.execute({ text: "Use bun" }, context)).toMatch(/already in/)
	})

	it("says when the saved entry falls outside the memory budget", async () => {
		const store = new MemoryStore({ rootDir: root, runGit: REMOTE })
		// Fill Important past a tiny budget; the new note under Notes cannot be shown.
		for (let index = 0; index < 20; index++) {
			await store.save("/work/a", { scope: "repo", text: `important fact number ${index}`, importance: "high" })
		}
		const tool = createSaveMemoryTool({ store, getCwd: () => "/work/a", getMaxTokens: () => 60 })
		const context = { agentId: "a", iteration: 1 }
		expect(await tool.execute({ text: "A note nobody will see" }, context)).toMatch(
			/at the top of Notes\. It is outside the memory budget/,
		)
		// Without the budget the tool cannot tell and does not claim either way.
		const blind = createSaveMemoryTool({ store, getCwd: () => "/work/a" })
		expect(await blind.execute({ text: "Another note" }, context)).toMatch(/Later conversations will see it/)
	})
})
