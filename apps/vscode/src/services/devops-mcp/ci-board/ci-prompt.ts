/**
 * Builds the prompt an action sends: a context header about the item (its
 * pipelines, the board's failure triage, the full report, the repository's
 * matching skills), then the action's own prompt.
 */
import { promises as fs } from "node:fs"
import path from "node:path"
import { defang } from "../ci-watch/ci-report-text"
import { DevOpsError } from "../server/errors"
import { BUILTIN_PROMPTS } from "./builtin-prompts"
import type { CiSkill } from "./ci-skills"
import type { CiBoardItem, CiBuiltinId, CiCategory, CiPipelineStatus, CiPromptSource, CiTriageResult } from "./types"

/** Marks the first line of a prompt the board sent. */
export const CI_BOARD_MARKER = "[CI BOARD]"

/** Drops a leading YAML front-matter block (`---` … `---`), which is metadata for other tools. */
export function stripFrontmatter(text: string): string {
	const match = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(text)
	return match ? text.slice(match[0].length).replace(/^\s*\r?\n/, "") : text
}

/** Replaces `{{name}}` with `vars[name]`; unknown names are left as written. */
export function renderTemplate(text: string, vars: Record<string, string | number | undefined>): string {
	return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) => {
		const value = vars[name]
		return value === undefined || value === "" ? match : String(value)
	})
}

/**
 * The text of an action's prompt. A relative file path is looked up in each of
 * `roots` in turn (the run's working copy first, then the repository).
 */
export async function loadPromptText(source: CiPromptSource, roots: string[]): Promise<string> {
	switch (source.kind) {
		case "builtin":
			return BUILTIN_PROMPTS[source.id].body
		case "text":
			return source.text
		case "file": {
			const candidates = path.isAbsolute(source.path) ? [source.path] : roots.map((root) => path.join(root, source.path))
			for (const candidate of candidates) {
				try {
					return stripFrontmatter(await fs.readFile(candidate, "utf8"))
				} catch {
					// try the next root
				}
			}
			throw new DevOpsError(`Cannot read the prompt file ${source.path} (looked in ${candidates.join(", ")}).`)
		}
	}
}

const MERGE_TEXT: Record<string, string> = {
	clean: "merges cleanly",
	conflicts: "CONFLICTS with the target branch",
	pending: "still being computed",
	unknown: "unknown",
}

const CATEGORY_TEXT: Record<CiCategory, string> = {
	conflict: "merge conflicts",
	build: "build failure",
	"test-regression": "test failure (possible regression)",
	"small-test-delta": "small test delta",
	infrastructure: "infrastructure",
	stale: "stale run",
	unknown: "unclassified",
}

function pipelineLine(p: CiPipelineStatus): string {
	const run = p.runId !== undefined ? ` (run ${p.runId})` : ""
	switch (p.color) {
		case "red":
			return `- ✗ ${p.name}: ${p.result ?? "failed"}${run}`
		case "green":
			return `- ✓ ${p.name}: passed${run}`
		case "yellow":
			return `- … ${p.name}: ${p.status === "queued" ? "queued" : "running"}${run}`
		default:
			return `- · ${p.name}: ${p.status ? (p.result ?? "no result") : "no run on this commit"}${run}`
	}
}

interface CiPromptContext {
	item: CiBoardItem
	/** Where the run works. */
	worktree: string
	inPlace: boolean
	remoteName: string
	notes: string[]
	/** The board's triage of the item, when it is for the item's current state. */
	triage?: CiTriageResult
	/** The built-in action being run, which picks the skills to mention. */
	builtin?: CiBuiltinId
	/** The repository's skills that fit the action. */
	skills?: CiSkill[]
	/** Started by auto-watch: nobody is watching the conversation. */
	auto?: boolean
}

function templateVars(ctx: CiPromptContext): Record<string, string | number | undefined> {
	const { item } = ctx
	return {
		prId: item.pr?.id,
		prUrl: item.pr?.url,
		sourceBranch: item.pr?.sourceBranch ?? item.branch,
		targetBranch: item.pr?.targetBranch,
		headSha: item.headSha,
		remote: ctx.remoteName,
		worktree: ctx.worktree,
		reportPath: ctx.triage?.reportPath,
		severity: ctx.triage?.severity,
	}
}

function triageLines(triage: CiTriageResult): string[] {
	const by = triage.source === "model" ? "a free model" : "rules on job and error text"
	const lines = [
		"",
		`Failure triage by ${by} (it may be wrong; check it against the logs):`,
		`- Severity: ${triage.severity}. ${defang(triage.summary)}`,
		...triage.pipelines.map((p) => `- ${p.name}: ${CATEGORY_TEXT[p.category]}: ${defang(p.summary)}`),
	]
	if (triage.reportPath) {
		lines.push(`- Full failure report: ${triage.reportPath} (read it before calling pipeline_report)`)
	}
	return lines
}

function skillLines(skills: CiSkill[]): string[] {
	if (!skills.length) {
		return ["", "No repository skill matches this task; follow the steps below."]
	}
	const listed = skills.map((s) => `\`/${s.name}\` (${s.path})`).join(", ")
	return [
		"",
		`This repository has skills for this task: ${listed}. Load the one that fits with the skills tool first and follow it. Where it disagrees with the push and recalibration rules below, those rules win.`,
	]
}

/** The header that tells the agent which PR, commit, pipelines and folder the run is about, followed by `body`. */
export function composeCiPrompt(ctx: CiPromptContext, body: string): string {
	const { item } = ctx
	const pr = item.pr
	const title = pr ? `PR #${pr.id} "${pr.title}" (${pr.sourceBranch} → ${pr.targetBranch})` : `branch ${item.branch}`
	const lines = [`${CI_BOARD_MARKER} ${title}`, ""]
	if (pr) lines.push(`- Pull request: ${pr.url}`)
	if (item.headSha) lines.push(`- Head commit: ${item.headSha}`)
	if (item.mergeState) lines.push(`- Merge state: ${MERGE_TEXT[item.mergeState] ?? item.mergeState}`)
	lines.push(
		`- Working copy: ${ctx.worktree} (${ctx.inPlace ? "the repository's own checkout" : "a git worktree of this branch"})`,
	)
	lines.push(`- Pass \`workspace: "${ctx.worktree}"\` to the plinycode-devops tools.`)
	if (item.pipelines.length) {
		lines.push("", "Pipelines on the head commit:", ...item.pipelines.map(pipelineLine))
	} else {
		lines.push("", "No pipeline has run on the head commit.")
	}
	if (ctx.triage?.status === "done" || ctx.triage?.status === "deferred") {
		lines.push(...triageLines(ctx.triage))
	}
	if (ctx.builtin && ctx.skills) {
		lines.push(...skillLines(ctx.skills))
	}
	if (ctx.notes.length) {
		lines.push("", "Notes:", ...ctx.notes.map((n) => `- ${n}`))
	}
	if (ctx.auto) {
		lines.push(
			"",
			"This is an unattended auto-watch run: nobody is watching. Do not ask questions; if you are blocked, stop and report why. Do not call watch_ci: the CI board watches this pull request.",
		)
	} else if (pr && ctx.builtin && ctx.builtin !== "investigate") {
		lines.push(
			"",
			`After you push, call \`watch_ci\` with \`pr: ${pr.id}\` and end your turn; you will be woken when CI finishes.`,
		)
	}
	lines.push("", "---", "", renderTemplate(body, templateVars(ctx)).trim())
	return lines.join("\n")
}
