/** Builds the prompt an action sends: a context header about the item, then the action's own prompt. */
import { promises as fs } from "node:fs"
import path from "node:path"
import { DevOpsError } from "../server/errors"
import { DEFAULT_CI_PROMPT } from "./default-ci-prompt"
import type { CiBoardItem, CiPipelineStatus, CiPromptSource } from "./types"

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
			return DEFAULT_CI_PROMPT
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
	}
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
	if (ctx.notes.length) {
		lines.push("", "Notes:", ...ctx.notes.map((n) => `- ${n}`))
	}
	lines.push("", "---", "", renderTemplate(body, templateVars(ctx)).trim())
	return lines.join("\n")
}
