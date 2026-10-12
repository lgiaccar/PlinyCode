import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { BUILTIN_PROMPTS } from "../builtin-prompts"
import { CI_BOARD_MARKER, composeCiPrompt, loadPromptText, renderTemplate, stripFrontmatter } from "../ci-prompt"
import { BUILTIN_IDS, type CiBoardItem, type CiTriageResult } from "../types"
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

	it("loads the built-in prompts, text, and files relative to the working copy first", async () => {
		const worktree = path.join(dir, "wt")
		const repo = path.join(dir, "repo")
		fs.mkdirSync(path.join(worktree, "prompts"), { recursive: true })
		fs.mkdirSync(path.join(repo, "prompts"), { recursive: true })
		fs.writeFileSync(path.join(worktree, "prompts", "fix.md"), "---\na: 1\n---\nfrom worktree")
		fs.writeFileSync(path.join(repo, "prompts", "only-repo.md"), "from repo")
		expect(await loadPromptText({ kind: "builtin", id: "fix-conflicts" }, [])).toBe(BUILTIN_PROMPTS["fix-conflicts"].body)
		expect(await loadPromptText({ kind: "text", text: "hi" }, [])).toBe("hi")
		expect(await loadPromptText({ kind: "file", path: "prompts/fix.md" }, [worktree, repo])).toBe("from worktree")
		expect(await loadPromptText({ kind: "file", path: "prompts/only-repo.md" }, [worktree, repo])).toBe("from repo")
		await expect(loadPromptText({ kind: "file", path: "missing.md" }, [worktree])).rejects.toThrow(
			/Cannot read the prompt file/,
		)
	})

	it("runs Investigate in Ask mode and every other built-in in Agent mode", () => {
		expect(BUILTIN_IDS.map((id) => [id, BUILTIN_PROMPTS[id].mode])).toEqual([
			["fix-conflicts", "act"],
			["recalibrate", "act"],
			["fix-ci", "act"],
			["investigate", "ask"],
		])
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

	const triage: CiTriageResult = {
		fingerprint: "f",
		itemKey: "k",
		status: "done",
		severity: "low",
		summary: "Two tests drift on @win_cpu.",
		pipelines: [{ name: "win_cpu", category: "small-test-delta", summary: "Volume 1.2% off", steps: [] }],
		conflict: true,
		recommended: ["fix-conflicts", "recalibrate"],
		source: "model",
		reportPath: "/repo/.plinycode/ci-reports/pr-12-aaaaaaa.md",
		analyzedTs: 1,
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

	it("fills every placeholder the built-in prompts use", () => {
		for (const id of BUILTIN_IDS) {
			const prompt = composeCiPrompt(
				{ item, worktree: "/wt", inPlace: true, remoteName: "origin", notes: [], builtin: id, skills: [] },
				BUILTIN_PROMPTS[id].body,
			)
			expect(prompt).not.toMatch(/\{\{\w+\}\}/)
			expect(prompt).toContain("the repository's own checkout")
		}
	})

	it("adds the triage, the report, the repository's skills and the watch step", () => {
		const prompt = composeCiPrompt(
			{
				item,
				worktree: "/wt",
				inPlace: false,
				remoteName: "origin",
				notes: [],
				triage,
				builtin: "recalibrate",
				skills: [{ name: "recalibrate-unit-tests", path: "/wt/.github/skills/recalibrate-unit-tests/SKILL.md" }],
			},
			BUILTIN_PROMPTS.recalibrate.body,
		)
		expect(prompt).toContain("Failure triage by a free model (it may be wrong; check it against the logs):")
		expect(prompt).toContain("- win_cpu: small test delta: Volume 1.2% off")
		// Mentions in CI-derived text are defanged so they are not expanded.
		expect(prompt).toContain("@​win_cpu")
		expect(prompt).toContain("- Full failure report: /repo/.plinycode/ci-reports/pr-12-aaaaaaa.md")
		expect(prompt).toContain("`/recalibrate-unit-tests` (/wt/.github/skills/recalibrate-unit-tests/SKILL.md)")
		expect(prompt).toContain("call `watch_ci` with `pr: 12`")
		expect(prompt).toContain("Never recalibrate a regression")
	})

	it("tells an unattended run not to ask or watch, and says when no skill matches", () => {
		const prompt = composeCiPrompt(
			{
				item,
				worktree: "/wt",
				inPlace: false,
				remoteName: "origin",
				notes: [],
				builtin: "fix-conflicts",
				skills: [],
				auto: true,
			},
			BUILTIN_PROMPTS["fix-conflicts"].body,
		)
		expect(prompt).toContain("unattended auto-watch run")
		expect(prompt).toContain("No repository skill matches this task")
		expect(prompt).not.toContain("call `watch_ci`")
	})

	it("leaves out a pending triage", () => {
		const prompt = composeCiPrompt(
			{ item, worktree: "/wt", inPlace: false, remoteName: "origin", notes: [], triage: { ...triage, status: "pending" } },
			"body",
		)
		expect(prompt).not.toContain("Failure triage")
	})
})
