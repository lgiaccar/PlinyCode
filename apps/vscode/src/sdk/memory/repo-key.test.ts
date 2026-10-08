import { describe, expect, it } from "vitest"
import type { GitRunner } from "../context/git-snapshot"
import { normalizeFolderPath, normalizeRemoteUrl, repoKeyFromIdentity, resolveRepoIdentity } from "./repo-key"

describe("normalizeRemoteUrl", () => {
	it("gives every spelling of one remote the same identity", () => {
		const expected = "github.com/synopsys/plinycode"
		for (const url of [
			"git@github.com:Synopsys/PlinyCode.git",
			"https://github.com/synopsys/plinycode",
			"https://user:token@github.com/Synopsys/PlinyCode.git/",
			"ssh://git@github.com:22/synopsys/plinycode.git",
		]) {
			expect(normalizeRemoteUrl(url)).toBe(expected)
		}
	})

	it("handles Azure DevOps remotes", () => {
		expect(normalizeRemoteUrl("https://org@dev.azure.com/org/Project/_git/Repo")).toBe("dev.azure.com/org/project/_git/repo")
		expect(normalizeRemoteUrl("git@ssh.dev.azure.com:v3/org/Project/Repo")).toBe("ssh.dev.azure.com/v3/org/project/repo")
	})

	it("treats a Windows path as a folder, not as an scp host", () => {
		expect(normalizeRemoteUrl("C:\\repos\\thing.git")).toBe(normalizeFolderPath("C:\\repos\\thing.git"))
		expect(normalizeRemoteUrl("   ")).toBeUndefined()
	})
})

describe("repoKeyFromIdentity", () => {
	it("is readable, short and stable", () => {
		const key = repoKeyFromIdentity("github.com/synopsys/plinycode")
		expect(key).toMatch(/^synopsys-plinycode-[0-9a-f]{8}$/)
		expect(repoKeyFromIdentity("github.com/synopsys/plinycode")).toBe(key)
		expect(repoKeyFromIdentity("github.com/other/plinycode")).not.toBe(key)
	})
})

function fakeGit(answers: Record<string, string | undefined>): GitRunner {
	return async (args) => {
		const out = answers[args.join(" ")]
		return out === undefined ? { stdout: "", exitCode: 128 } : { stdout: `${out}\n`, exitCode: 0 }
	}
}

describe("resolveRepoIdentity", () => {
	it("prefers the origin remote, so clones and worktrees share a key", async () => {
		const a = await resolveRepoIdentity(
			"/work/a",
			fakeGit({ "remote get-url origin": "git@github.com:org/repo.git", "rev-parse --show-toplevel": "/work/a" }),
		)
		const b = await resolveRepoIdentity(
			"/work/b.worktrees/pr-1",
			fakeGit({ "remote get-url origin": "https://github.com/org/repo" }),
		)
		expect(a.kind).toBe("remote")
		expect(a.key).toBe(b.key)
		expect(a.remoteUrl).toBe("git@github.com:org/repo.git")
	})

	it("falls back to the top-level folder, then to the folder itself", async () => {
		const local = await resolveRepoIdentity("/work/local/src", fakeGit({ "rev-parse --show-toplevel": "/work/local" }))
		expect(local.kind).toBe("toplevel")
		expect(local.identity).toBe(normalizeFolderPath("/work/local"))

		const plain = await resolveRepoIdentity("/notes", fakeGit({}))
		expect(plain.kind).toBe("folder")
		expect(plain.identity).toBe(normalizeFolderPath("/notes"))
	})

	it("never throws when git cannot run", async () => {
		const broken: GitRunner = async () => {
			throw new Error("spawn git ENOENT")
		}
		expect((await resolveRepoIdentity("/x", broken)).kind).toBe("folder")
	})
})
