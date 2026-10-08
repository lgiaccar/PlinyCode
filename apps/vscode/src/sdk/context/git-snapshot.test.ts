import { describe, expect, it, vi } from "vitest"
import { type GitRunner, type GitRunResult, gatherGitSnapshot } from "./git-snapshot"

type FakeCommand = GitRunResult | "hang"

/**
 * A git that answers each subcommand from a table. "hang" never finishes on
 * its own: like a real process, it ends only when the time limit aborts it.
 */
function fakeGit(commands: Record<string, FakeCommand>, partialOutput: Record<string, string> = {}) {
	const runner = vi.fn<GitRunner>((args, { signal }) => {
		const command = commands[args[0]] ?? { stdout: "", exitCode: 128 }
		if (command !== "hang") {
			return Promise.resolve(command)
		}
		return new Promise<GitRunResult>((resolve) => {
			signal.addEventListener("abort", () => resolve({ stdout: partialOutput[args[0]] ?? "", timedOut: true }))
		})
	})
	return runner
}

const ok = (stdout: string): GitRunResult => ({ stdout, exitCode: 0 })

const REPOSITORY = {
	"symbolic-ref": ok("feature/env\n"),
	"for-each-ref": ok("refs/remotes/origin/HEAD refs/remotes/origin/stage\nrefs/heads/main \n"),
	"rev-parse": ok("abc1234\n"),
	status: ok(" M src/app.ts\n?? notes.md\n"),
}

describe("gatherGitSnapshot", () => {
	it("gathers the branch, default branch and status, but not the commit history", async () => {
		const runGit = fakeGit(REPOSITORY)

		expect(await gatherGitSnapshot("/repo", { runGit })).toEqual({
			branch: "feature/env",
			defaultBranch: "stage",
			status: [" M src/app.ts", "?? notes.md"],
		})
		// One process per question, all in the workspace folder.
		expect(runGit).toHaveBeenCalledTimes(4)
		for (const [, options] of runGit.mock.calls) {
			expect(options.cwd).toBe("/repo")
		}
		expect(runGit.mock.calls.map(([args]) => args[0]).sort()).toEqual(["for-each-ref", "rev-parse", "status", "symbolic-ref"])
		expect(runGit.mock.calls.find(([args]) => args[0] === "rev-parse")?.[0]).toEqual(["rev-parse", "--short", "HEAD"])
	})

	it("reports a clean working tree as an empty status", async () => {
		const snapshot = await gatherGitSnapshot("/repo", { runGit: fakeGit({ ...REPOSITORY, status: ok("") }) })

		expect(snapshot?.status).toEqual([])
		expect(snapshot?.statusOmitted).toBeUndefined()
	})

	it("returns nothing outside a git repository", async () => {
		// `git` exits 128 with "fatal: not a git repository" for every command.
		expect(await gatherGitSnapshot("/tmp/plain", { runGit: fakeGit({}) })).toBeUndefined()
	})

	it("returns nothing when git is not installed", async () => {
		const runGit = vi.fn<GitRunner>(async () => ({ stdout: "" }))
		expect(await gatherGitSnapshot("/repo", { runGit })).toBeUndefined()

		const throwing = vi.fn<GitRunner>(async () => {
			throw new Error("spawn git ENOENT")
		})
		expect(await gatherGitSnapshot("/repo", { runGit: throwing })).toBeUndefined()
	})

	it("keeps the first 20 status entries and counts the rest", async () => {
		const entries = Array.from({ length: 57 }, (_, index) => ` M src/file-${index}.ts`)
		const snapshot = await gatherGitSnapshot("/repo", {
			runGit: fakeGit({ ...REPOSITORY, status: ok(`${entries.join("\n")}\n`) }),
		})

		expect(snapshot?.status).toEqual(entries.slice(0, 20))
		expect(snapshot?.statusOmitted).toBe(37)
		expect(snapshot?.statusIncomplete).toBeUndefined()
	})

	it("shows what it has when git status runs out of time", async () => {
		const startedAt = Date.now()
		const snapshot = await gatherGitSnapshot("/big-repo", {
			runGit: fakeGit({ ...REPOSITORY, status: "hang" }),
			timeoutMs: 30,
		})

		expect(Date.now() - startedAt).toBeLessThan(1000)
		expect(snapshot).toEqual({
			branch: "feature/env",
			defaultBranch: "stage",
			statusIncomplete: true,
		})
	})

	it("keeps the complete lines of a status that was cut off", async () => {
		const snapshot = await gatherGitSnapshot("/big-repo", {
			runGit: fakeGit({ ...REPOSITORY, status: "hang" }, { status: " M src/a.ts\n M src/b.ts\n M src/half-writ" }),
			timeoutMs: 30,
		})

		expect(snapshot?.status).toEqual([" M src/a.ts", " M src/b.ts"])
		expect(snapshot?.statusIncomplete).toBe(true)
	})

	it("returns nothing, on time, when every command hangs", async () => {
		const startedAt = Date.now()
		const snapshot = await gatherGitSnapshot("/stuck", {
			runGit: fakeGit({ "symbolic-ref": "hang", "for-each-ref": "hang", "rev-parse": "hang", status: "hang" }),
			timeoutMs: 30,
		})

		expect(snapshot).toBeUndefined()
		expect(Date.now() - startedAt).toBeLessThan(1000)
	})

	it("gives up on a runner that ignores the time limit", async () => {
		const deaf = vi.fn<GitRunner>(() => new Promise<GitRunResult>(() => {}))
		const startedAt = Date.now()

		expect(await gatherGitSnapshot("/stuck", { runGit: deaf, timeoutMs: 30 })).toBeUndefined()
		expect(Date.now() - startedAt).toBeLessThan(1000)
	})

	it("describes a detached HEAD by its commit", async () => {
		const snapshot = await gatherGitSnapshot("/repo", {
			runGit: fakeGit({ ...REPOSITORY, "symbolic-ref": { stdout: "", exitCode: 1 } }),
		})

		expect(snapshot?.branch).toBeUndefined()
		expect(snapshot?.head).toBe("abc1234")
	})

	it("handles a repository without commits", async () => {
		const snapshot = await gatherGitSnapshot("/new-repo", {
			runGit: fakeGit({
				"symbolic-ref": ok("main\n"),
				"for-each-ref": ok(""),
				"rev-parse": { stdout: "HEAD\n", exitCode: 128 },
				status: ok("?? README.md\n"),
			}),
		})

		expect(snapshot).toEqual({ branch: "main", status: ["?? README.md"] })
	})

	it("falls back to a main or master branch when origin/HEAD is not set", async () => {
		const withRefs = (refs: string) =>
			gatherGitSnapshot("/repo", { runGit: fakeGit({ ...REPOSITORY, "for-each-ref": ok(refs) }) })

		expect((await withRefs("refs/heads/master \nrefs/remotes/origin/main \n"))?.defaultBranch).toBe("main")
		expect((await withRefs("refs/heads/master \n"))?.defaultBranch).toBe("master")
		expect((await withRefs(""))?.defaultBranch).toBeUndefined()
	})

	it("keeps every entry on one bounded line", async () => {
		const snapshot = await gatherGitSnapshot("/repo", {
			runGit: fakeGit({
				...REPOSITORY,
				status: ok(` M ${"long/".repeat(60)}x.ts\n?? bell\u0007 and escape\u001b[31m.md\n`),
			}),
		})

		expect(snapshot?.status?.[0]).toHaveLength(200)
		expect(snapshot?.status?.[0].endsWith("…")).toBe(true)
		expect(snapshot?.status?.[1]).toBe("?? bell and escape[31m.md")
	})
})
