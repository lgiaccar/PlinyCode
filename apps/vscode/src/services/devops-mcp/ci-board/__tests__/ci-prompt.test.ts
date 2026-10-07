import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { CI_BOARD_MARKER, composeCiPrompt, loadPromptText, renderTemplate, stripFrontmatter } from "../ci-prompt"
import { DEFAULT_CI_PROMPT } from "../default-ci-prompt"
import type { CiBoardItem } from "../types"
import { boardPr, SHA_A } from "./fake-board-provider"

describe("prompt text", () => {
	let dir: string

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-prompt-"))
	})

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("strips front matter, and only a leading block", () => {
		expect(stripFrontmatter("---\nskill: x\nLOAD_ONLY:\n  - a/**\n---\n\n# Title\n")).toBe("# Title\n")
		expect(stripFrontmatter("# Title\n---\nnot: front matter\n---\n")).toBe("# Title\n---\nnot: front matter\n---\n")
	})

	it("fills known placeholders and leaves the rest", () => {
		expect(renderTemplate("PR {{prId}} on {{ targetBranch }} {{other}}", { prId: 7, targetBranch: "main" })).toBe(
			"PR 7 on main {{other}}",
		)
	})

	it("loads the built-in prompt, text, and files relative to the working copy first", async () => {
		const worktree = path.join(dir, "wt")
		const repo = path.join(dir, "repo")
		fs.mkdirSync(path.join(worktree, "prompts"), { recursive: true })
		fs.mkdirSync(path.join(repo, "prompts"), { recursive: true })
		fs.writeFileSync(path.join(worktree, "prompts", "fix.md"), "---\na: 1\n---\nfrom worktree")
		fs.writeFileSync(path.join(repo, "prompts", "only-repo.md"), "from repo")
		expect(await loadPromptText({ kind: "builtin" }, [])).toBe(DEFAULT_CI_PROMPT)
		expect(await loadPromptText({ kind: "text", text: "hi" }, [])).toBe("hi")
		expect(await loadPromptText({ kind: "file", path: "prompts/fix.md" }, [worktree, repo])).toBe("from worktree")
		expect(await loadPromptText({ kind: "file", path: "prompts/only-repo.md" }, [worktree, repo])).toBe("from repo")
		await expect(loadPromptText({ kind: "file", path: "missing.md" }, [worktree])).rejects.toThrow(
			/Cannot read the prompt file/,
		)
	})
})

describe("composeCiPrompt", () => {
	const item: CiBoardItem = {
		key: "k",
		pr: boardPr(12, { title: "Speed up", sourceBranch: "feature", targetBranch: "stage" }),
		branch: "feature",
		headSha: SHA_A,
		mergeState: "conflicts",
		fork: false,
		pipelines: [
			{ name: "win_cpu", color: "red", status: "completed", result: "failure", runId: 101 },
			{ name: "linux_cpu", color: "green", status: "completed", result: "success", runId: 102 },
			{ name: "win_cuda", color: "grey" },
		],
	}

	it("puts the PR, its pipelines and the working copy ahead of the prompt, with placeholders filled", () => {
		const prompt = composeCiPrompt(
			{ item, worktree: "/wt/feature", inPlace: false, remoteName: "origin", notes: ["Submodules failed"] },
			"Merge {{remote}}/{{targetBranch}} into {{sourceBranch}}, then watch PR {{prId}} in {{worktree}}.",
		)
		expect(prompt.split("\n")[0]).toBe(`${CI_BOARD_MARKER} PR #12 "Speed up" (feature → stage)`)
		expect(prompt).toContain("- Merge state: CONFLICTS with the target branch")
		expect(prompt).toContain("- ✗ win_cpu: failure (run 101)")
		expect(prompt).toContain("- · win_cuda: no run on this commit")
		expect(prompt).toContain('`workspace: "/wt/feature"`')
		expect(prompt).toContain("- Submodules failed")
		expect(prompt).toEndWith("Merge origin/stage into feature, then watch PR 12 in /wt/feature.")
	})

	it("fills every placeholder the built-in prompt uses", () => {
		const prompt = composeCiPrompt(
			{ item, worktree: "/wt", inPlace: true, remoteName: "origin", notes: [] },
			DEFAULT_CI_PROMPT,
		)
		expect(prompt).not.toMatch(/\{\{\w+\}\}/)
		expect(prompt).toContain("the repository's own checkout")
	})
})
