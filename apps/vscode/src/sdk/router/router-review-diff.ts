/**
 * What a run changed, in the form the reviewer pass (`router-review.ts`) sends
 * to the reviewing model.
 *
 * Two sources, in order of preference:
 *   - the checkpoint taken when the run started, compared with the working
 *     tree: exact, with line numbers, and it includes what shell commands and
 *     sub-agents changed;
 *   - the run's own successful `editor` / `apply_patch` calls, for workspaces
 *     without checkpoints (not a git repository, checkpoints switched off).
 *     These are the edits as the model wrote them: no line numbers, and an
 *     edit that a later one overwrote still shows.
 *
 * Kept free of I/O so the skip rules and the size cap can be tested directly.
 */

import path from "node:path"
import type { AgentMessage, AgentToolCallPart } from "@plinycode/shared"
import { diffLines, structuredPatch } from "diff"

/** Tools whose successful call means the run changed a file. */
const EDIT_TOOLS = new Set(["editor", "apply_patch"])

/** About 6k tokens: room for a real change, small enough for every free model and a quick answer. */
export const REVIEW_DIFF_MAX_CHARS = 24_000

/** A one- or two-line change is cheaper to trust than to review. */
export const REVIEW_MIN_CHANGED_LINES = 3

/** Below this share a file's diff says too little to review; later files are named instead. */
const MIN_CHARS_PER_FILE = 600

/** Diffing a file this large costs more than its review is worth; it is named, not shown. */
const MAX_DIFFABLE_CHARS = 400_000

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".rst", ".txt", ".adoc"])
const DOC_BASENAMES = /^(readme|changelog|changes|license|licence|notice|authors|contributing)$/i
const LOCKFILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|go\.sum|[^/]+\.lockb?)$/i

export interface ReviewFileChange {
	/** Relative to the workspace, with forward slashes. */
	path: string
	/** The file's hunks, without a file header. Empty for a deleted or opaque file. */
	diff: string
	added: number
	removed: number
	status?: "added" | "deleted" | "modified"
	/** Binary or too large to diff: named for the reviewer, never shown. */
	opaque?: boolean
}

export type ReviewChangeSkip = "no-changes" | "docs-only" | "small-change"

function relativePath(filePath: string, cwd: string | undefined): string {
	const relative = cwd && path.isAbsolute(filePath) ? path.relative(cwd, filePath) || path.basename(filePath) : filePath
	return relative.replace(/\\/g, "/")
}

/** Markdown and other prose: a reviewer hunting for defects has nothing to find there. */
export function isDocsPath(filePath: string): boolean {
	const base = path.posix.basename(filePath.replace(/\\/g, "/"))
	const extension = path.posix.extname(base).toLowerCase()
	return extension ? DOC_EXTENSIONS.has(extension) : DOC_BASENAMES.test(base)
}

function isReviewable(change: ReviewFileChange): boolean {
	return !change.opaque && !isDocsPath(change.path) && !LOCKFILES.test(change.path)
}

/**
 * Per-file unified diffs from a checkpoint comparison. Line endings are
 * normalised first, so a file whose only change is CRLF/LF is dropped rather
 * than shown as rewritten.
 */
export function changesFromCheckpoint(
	diffs: ReadonlyArray<{ filePath: string; leftContent: string; rightContent: string }>,
	cwd?: string,
): ReviewFileChange[] {
	const changes: ReviewFileChange[] = []
	for (const entry of diffs) {
		const left = entry.leftContent.replace(/\r\n/g, "\n")
		const right = entry.rightContent.replace(/\r\n/g, "\n")
		if (left === right) {
			continue
		}
		const file = relativePath(entry.filePath, cwd)
		const status = left.length === 0 ? "added" : right.length === 0 ? "deleted" : "modified"
		if (left.includes("\u0000") || right.includes("\u0000") || left.length + right.length > MAX_DIFFABLE_CHARS) {
			changes.push({ path: file, diff: "", added: 0, removed: 0, status, opaque: true })
			continue
		}
		if (status === "deleted") {
			// The content of a deleted file is not worth the reviewer's budget.
			changes.push({ path: file, diff: "", added: 0, removed: left.replace(/\n$/, "").split("\n").length, status })
			continue
		}
		const lines: string[] = []
		let added = 0
		let removed = 0
		for (const hunk of structuredPatch(file, file, left, right, undefined, undefined, { context: 3 }).hunks) {
			lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`)
			for (const line of hunk.lines) {
				if (line.startsWith("+")) {
					added += 1
				} else if (line.startsWith("-")) {
					removed += 1
				}
				lines.push(line)
			}
		}
		changes.push({ path: file, diff: lines.join("\n"), added, removed, status })
	}
	return changes
}

/** Whether a tool result reports success: no error flag, and no `success: false` entry. */
function succeeded(part: { output: unknown; isError?: boolean }): boolean {
	if (part.isError) {
		return false
	}
	const entries = Array.isArray(part.output) ? part.output : [part.output]
	return entries.every((entry) => !(entry && typeof entry === "object" && (entry as Record<string, unknown>).success === false))
}

/** Whether a finished tool call wrote to a file. */
export function isSuccessfulEdit(toolName: string, result: { output: unknown; isError?: boolean }): boolean {
	return EDIT_TOOLS.has(toolName) && succeeded(result)
}

/**
 * The messages of the current user turn: everything after the user's latest
 * own message. A recovered run continues the same turn in a new run, and a
 * message sent mid-run starts no new one, so the turn is whichever reaches
 * further back: that message or the start of the current run. "The user's own
 * message" follows `latestUserRequest`: not a tool result, not a reminder.
 */
export function currentTurnMessages(
	messages: readonly AgentMessage[] | undefined,
	runMessages: readonly AgentMessage[] | undefined,
): readonly AgentMessage[] {
	const all = messages ?? runMessages ?? []
	const runStart = runMessages ? Math.max(0, all.length - runMessages.length) : undefined
	for (let index = all.length - 1; index >= 0; index -= 1) {
		const message = all[index]
		if (message?.role !== "user") {
			continue
		}
		const metadata = message.metadata ?? {}
		const injected = metadata.displayRole === "system" || metadata.userRunSpan === 0
		const text = message.content.find((part) => part.type === "text")
		if (injected || !text || text.type !== "text" || /^\s*(\[SYSTEM\]|<hook_context)/.test(text.text)) {
			continue
		}
		return all.slice(Math.min(runStart ?? index + 1, index + 1))
	}
	return all.slice(runStart ?? 0)
}

/** The successful `editor` / `apply_patch` calls among these messages, each with the input it was called with. */
function successfulEdits(messages: readonly AgentMessage[]): Array<{ toolName: string; input: unknown }> {
	const calls = new Map<string, AgentToolCallPart>()
	const edits: Array<{ toolName: string; input: unknown }> = []
	for (const message of messages) {
		for (const part of message.content) {
			if (part.type === "tool-call") {
				calls.set(part.toolCallId, part)
			} else if (part.type === "tool-result" && isSuccessfulEdit(part.toolName, part)) {
				edits.push({ toolName: part.toolName, input: calls.get(part.toolCallId)?.input })
			}
		}
	}
	return edits
}

/** How many successful file edits these messages hold. */
export function countSuccessfulEdits(messages: readonly AgentMessage[]): number {
	return successfulEdits(messages).length
}

function prefixed(text: string, prefix: string): string[] {
	return text
		.replace(/\r\n/g, "\n")
		.replace(/\n$/, "")
		.split("\n")
		.map((line) => `${prefix}${line}`)
}

/** One `editor` call as diff lines: the replaced text against the new text, or the inserted or created text. */
function editorCallDiff(input: Record<string, unknown>): { lines: string[]; added: number; removed: number } {
	const newText = typeof input.new_text === "string" ? input.new_text : ""
	const oldText = typeof input.old_text === "string" ? input.old_text : ""
	if (input.insert_line !== undefined && input.insert_line !== null) {
		const lines = prefixed(newText, "+")
		return { lines: [`@@ inserted at line ${String(input.insert_line)} @@`, ...lines], added: lines.length, removed: 0 }
	}
	if (!oldText) {
		const lines = prefixed(newText, "+")
		return { lines: ["@@ file written @@", ...lines], added: lines.length, removed: 0 }
	}
	const lines = ["@@ text replaced @@"]
	let added = 0
	let removed = 0
	for (const part of diffLines(oldText.replace(/\r\n/g, "\n"), newText.replace(/\r\n/g, "\n"))) {
		const body = prefixed(part.value, part.added ? "+" : part.removed ? "-" : " ")
		added += part.added ? body.length : 0
		removed += part.removed ? body.length : 0
		lines.push(...body)
	}
	return { lines, added, removed }
}

const PATCH_FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/

/**
 * Rebuild per-file changes from the run's successful edit calls, in call
 * order, with all edits to one file under one entry.
 */
export function changesFromToolCalls(messages: readonly AgentMessage[], cwd?: string): ReviewFileChange[] {
	const byPath = new Map<string, { lines: string[]; added: number; removed: number; status?: ReviewFileChange["status"] }>()
	const entryFor = (filePath: string) => {
		const file = relativePath(filePath.trim(), cwd)
		let entry = byPath.get(file)
		if (!entry) {
			entry = { lines: [], added: 0, removed: 0 }
			byPath.set(file, entry)
		}
		return entry
	}

	for (const edit of successfulEdits(messages)) {
		if (edit.toolName === "editor") {
			const input = edit.input && typeof edit.input === "object" ? (edit.input as Record<string, unknown>) : undefined
			if (!input || typeof input.path !== "string") {
				continue
			}
			const entry = entryFor(input.path)
			const call = editorCallDiff(input)
			entry.lines.push(...call.lines)
			entry.added += call.added
			entry.removed += call.removed
			continue
		}
		// apply_patch: the patch text is already a diff, one section per file.
		const input = edit.input
		const patch =
			typeof input === "string"
				? input
				: input && typeof input === "object" && typeof (input as Record<string, unknown>).input === "string"
					? ((input as Record<string, unknown>).input as string)
					: ""
		let entry: ReturnType<typeof entryFor> | undefined
		for (const line of patch.replace(/\r\n/g, "\n").split("\n")) {
			const header = line.match(PATCH_FILE_HEADER)
			if (header) {
				entry = entryFor(header[2] ?? "")
				entry.status = header[1] === "Add" ? "added" : header[1] === "Delete" ? "deleted" : (entry.status ?? "modified")
				continue
			}
			if (!entry || /^\*\*\* (Begin|End) Patch/.test(line)) {
				continue
			}
			entry.lines.push(line)
			if (line.startsWith("+")) {
				entry.added += 1
			} else if (line.startsWith("-")) {
				entry.removed += 1
			}
		}
	}

	return [...byPath.entries()].map(([file, entry]) => ({
		path: file,
		diff: entry.lines.join("\n"),
		added: entry.added,
		removed: entry.removed,
		...(entry.status ? { status: entry.status } : {}),
	}))
}

/**
 * Split a run's changes into what the reviewer reads and what it is only told
 * about, and decide whether the change is worth a review at all.
 */
export function assessChanges(changes: readonly ReviewFileChange[]): {
	reviewable: ReviewFileChange[]
	/** Docs, lockfiles, binaries: named in the prompt, not shown. */
	namedOnly: string[]
	added: number
	removed: number
	skip?: ReviewChangeSkip
} {
	const reviewable = changes.filter(isReviewable)
	const namedOnly = changes.filter((change) => !isReviewable(change)).map((change) => change.path)
	const added = reviewable.reduce((sum, change) => sum + change.added, 0)
	const removed = reviewable.reduce((sum, change) => sum + change.removed, 0)
	const skip: ReviewChangeSkip | undefined =
		changes.length === 0
			? "no-changes"
			: reviewable.length === 0
				? "docs-only"
				: added + removed < REVIEW_MIN_CHANGED_LINES
					? "small-change"
					: undefined
	return { reviewable, namedOnly, added, removed, ...(skip ? { skip } : {}) }
}

function fileHeader(change: ReviewFileChange): string {
	const what =
		change.status === "deleted"
			? `deleted, ${change.removed} lines`
			: `${change.status === "added" ? "new file, " : ""}+${change.added} -${change.removed}`
	return `=== ${change.path} (${what}) ===`
}

/** File names for a note, cut short when the list would crowd out the diff itself. */
function nameList(paths: readonly string[]): string {
	const maxNames = 20
	return paths.length > maxNames
		? `${paths.slice(0, maxNames).join(", ")} and ${paths.length - maxNames} more`
		: paths.join(", ")
}

/** Cut a diff to about `limit` characters at a line boundary, saying how much is missing. */
function truncateDiff(diff: string, limit: number): string {
	const lines = diff.split("\n")
	const kept: string[] = []
	let used = 0
	for (const line of lines) {
		if (used + line.length + 1 > limit) {
			break
		}
		kept.push(line)
		used += line.length + 1
	}
	return [...kept, `[… ${lines.length - kept.length} more lines of this file's diff are not shown]`].join("\n")
}

/**
 * The diff text for the reviewer, capped at about `maxChars`. The budget is
 * shared out per file, smallest first, so short diffs stay whole and what they
 * leave over goes to the long ones; a cut file says so, and files that do not
 * fit at all are named.
 */
export function buildReviewDiff(
	reviewable: readonly ReviewFileChange[],
	namedOnly: readonly string[] = [],
	maxChars: number = REVIEW_DIFF_MAX_CHARS,
): { text: string; truncated: string[]; omitted: string[] } {
	const shownCount = Math.max(1, Math.min(reviewable.length, Math.floor(maxChars / MIN_CHARS_PER_FILE)))
	const shown = reviewable.slice(0, shownCount)
	const omitted = reviewable.slice(shownCount).map((change) => change.path)

	const allowance = new Map<ReviewFileChange, number>()
	let remaining = maxChars - shown.reduce((sum, change) => sum + fileHeader(change).length + 2, 0)
	const bySize = [...shown].sort((a, b) => a.diff.length - b.diff.length)
	bySize.forEach((change, index) => {
		const share = Math.max(0, Math.floor(remaining / (bySize.length - index)))
		const take = Math.min(change.diff.length, share)
		allowance.set(change, take)
		remaining -= take
	})

	const truncated: string[] = []
	const sections = shown.map((change) => {
		const limit = allowance.get(change) ?? 0
		if (change.diff.length <= limit) {
			return change.diff ? `${fileHeader(change)}\n${change.diff}` : fileHeader(change)
		}
		truncated.push(change.path)
		return `${fileHeader(change)}\n${truncateDiff(change.diff, limit)}`
	})
	if (omitted.length > 0) {
		sections.push(`[${omitted.length} more changed files are not shown: ${nameList(omitted)}]`)
	}
	if (namedOnly.length > 0) {
		sections.push(`[Also changed, not shown (documentation, lockfiles, binary or very large files): ${nameList(namedOnly)}]`)
	}
	return { text: sections.join("\n\n"), truncated, omitted }
}
