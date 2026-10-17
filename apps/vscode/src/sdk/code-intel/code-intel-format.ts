/**
 * Pure helpers for the code intelligence tools: finding where a symbol sits in
 * a document, reducing hover markdown, and laying results out in as few
 * tokens as a model needs to act on them.
 */

import * as path from "path"
import type { CodeDiagnostic, CodeFileDiagnostics, CodeHover, CodeLocation, CodeSymbol, CodeTextEdit } from "./code-intel-source"

/** How many result lines a navigation answer shows before summarising the rest. */
export const MAX_RESULT_LINES = 30
/** How many callers or callees a call-hierarchy answer shows. */
export const MAX_CALL_LINES = 25
/** How many files a rename preview lists. */
export const MAX_RENAME_FILES = 20
/** How many changed lines a rename preview shows per file. */
export const MAX_RENAME_LINES_PER_FILE = 3
const MAX_DIAGNOSTIC_LINES = 20
const MAX_DIAGNOSTIC_CHARS = 200
/** How many files a workspace-wide problems list shows. */
const MAX_WORKSPACE_ERROR_FILES = 10
/** How many errors a workspace-wide problems list shows per file. */
const MAX_WORKSPACE_ERRORS_PER_FILE = 5
/** How many symbols a workspace-wide lookup shows. */
const MAX_WORKSPACE_SYMBOLS = 40
/** How many outline entries a single file shows. */
const MAX_OUTLINE_LINES = 120
const MAX_PREVIEW_CHARS = 120
const MAX_DOC_LINES = 6

interface SymbolPosition {
	line: number
	column: number
}

/**
 * Finds the symbol in the document as a whole identifier, so the model never
 * has to compute a column. With `preferredLine` the occurrence nearest to that
 * line wins, otherwise the first one. A dotted name (`Foo.bar`) is tried whole
 * first, then by its last segment.
 */
export function locateSymbol(text: string, symbol: string, preferredLine?: number): SymbolPosition | undefined {
	const candidates = [symbol.trim()]
	if (symbol.includes(".")) {
		candidates.push(symbol.slice(symbol.lastIndexOf(".") + 1))
	}
	for (const candidate of candidates) {
		if (!candidate) {
			continue
		}
		const occurrences = findIdentifier(text, candidate)
		if (occurrences.length === 0) {
			continue
		}
		if (preferredLine === undefined || !Number.isFinite(preferredLine)) {
			return occurrences[0]
		}
		let best = occurrences[0]
		for (const occurrence of occurrences) {
			if (Math.abs(occurrence.line - preferredLine) < Math.abs(best.line - preferredLine)) {
				best = occurrence
			}
		}
		return best
	}
	return undefined
}

function findIdentifier(text: string, identifier: string): SymbolPosition[] {
	const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	// An identifier boundary rather than \b: `$` and `_` are identifier characters.
	const pattern = new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "g")
	const positions: SymbolPosition[] = []
	const lines = text.split(/\r?\n/)
	for (let index = 0; index < lines.length; index++) {
		pattern.lastIndex = 0
		let match: RegExpExecArray | null = pattern.exec(lines[index])
		while (match) {
			positions.push({ line: index + 1, column: match.index + 1 })
			if (match[0].length === 0) {
				pattern.lastIndex++
			}
			match = pattern.exec(lines[index])
		}
	}
	return positions
}

/**
 * Reduces the markdown of a hover to its code-fenced lines (signatures, types)
 * and a few lines of prose. Models want the signature; the fences, the
 * `*@param*` emphasis and the horizontal rules only cost tokens.
 */
export function reduceHoverMarkdown(values: readonly string[]): CodeHover {
	const signature: string[] = []
	const documentation: string[] = []
	for (const value of values) {
		const fence = /```[^\n]*\n([\s\S]*?)```/g
		let rest = value
		let match: RegExpExecArray | null = fence.exec(value)
		while (match) {
			for (const line of match[1].split(/\r?\n/)) {
				const trimmed = line.trim()
				if (trimmed) {
					signature.push(trimmed)
				}
			}
			match = fence.exec(value)
		}
		rest = rest.replace(/```[^\n]*\n[\s\S]*?```/g, "\n")
		for (const line of rest.split(/\r?\n/)) {
			const cleaned = line
				.replace(/^\s*(?:---+|\*\*\*+)\s*$/, "")
				.replace(/[*_`]/g, "")
				.replace(/\\([*_`$])/g, "$1")
				.trim()
			if (cleaned && documentation.length < MAX_DOC_LINES) {
				documentation.push(cleaned)
			}
		}
	}
	return { signature: dedupe(signature), documentation }
}

function dedupe(lines: string[]): string[] {
	return lines.filter((line, index) => lines.indexOf(line) === index)
}

export function displayPath(absolutePath: string, cwd: string): string {
	const relative = path.relative(cwd, absolutePath)
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return absolutePath.replace(/\\/g, "/")
	}
	return relative.replace(/\\/g, "/")
}

export function trimPreview(line: string | undefined): string {
	const trimmed = (line ?? "").trim().replace(/\s+/g, " ")
	return trimmed.length > MAX_PREVIEW_CHARS ? `${trimmed.slice(0, MAX_PREVIEW_CHARS - 1)}…` : trimmed
}

export interface LocatedResult extends CodeLocation {
	preview?: string
}

/**
 * Lays out locations grouped by file, `line:col  preview` under each path,
 * and summarises whatever does not fit in `maxLines`.
 */
export function formatLocations(locations: readonly LocatedResult[], cwd: string, maxLines = MAX_RESULT_LINES): string[] {
	const byFile = new Map<string, LocatedResult[]>()
	for (const location of locations) {
		const key = location.path
		const list = byFile.get(key)
		if (list) {
			list.push(location)
		} else {
			byFile.set(key, [location])
		}
	}
	const lines: string[] = []
	const shownPerFile = new Map<string, number>()
	for (const [file, list] of byFile) {
		if (lines.length >= maxLines) {
			break
		}
		lines.push(displayPath(file, cwd))
		let shown = 0
		for (const location of list) {
			if (lines.length >= maxLines) {
				break
			}
			lines.push(`  ${location.line}:${location.column}${location.preview ? `  ${location.preview}` : ""}`)
			shown++
		}
		shownPerFile.set(file, shown)
	}
	let remaining = 0
	let remainingFiles = 0
	for (const [file, list] of byFile) {
		const unshown = list.length - (shownPerFile.get(file) ?? 0)
		if (unshown > 0) {
			remaining += unshown
			remainingFiles++
		}
	}
	if (remaining > 0) {
		lines.push(`+${remaining} more in ${remainingFiles} file${remainingFiles === 1 ? "" : "s"}`)
	}
	return lines
}

/** `kind name  path:line:col  (in container)`, capped. */
export function formatWorkspaceSymbols(symbols: readonly CodeSymbol[], cwd: string, max = MAX_WORKSPACE_SYMBOLS): string[] {
	const lines = symbols
		.slice(0, max)
		.map(
			(symbol) =>
				`${symbol.kind} ${symbol.name}  ${displayPath(symbol.path, cwd)}:${symbol.line}:${symbol.column}` +
				(symbol.container ? `  (in ${symbol.container})` : ""),
		)
	if (symbols.length > max) {
		lines.push(`+${symbols.length - max} more; narrow the query or pass a path`)
	}
	return lines
}

/** An indented outline, `kind name  line`, capped. */
export function formatOutline(symbols: readonly CodeSymbol[], max = MAX_OUTLINE_LINES): string[] {
	const lines = symbols
		.slice(0, max)
		.map((symbol) => `${"  ".repeat(symbol.depth ?? 0)}${symbol.kind} ${symbol.name}  ${symbol.line}`)
	if (symbols.length > max) {
		lines.push(`+${symbols.length - max} more`)
	}
	return lines
}

/** `3 edits`, `1 edit`. */
export function countOf(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`
}

export interface LocatedCall extends LocatedResult {
	kind: string
	name: string
}

/** `kind name  path:line:col  preview`, capped. */
export function formatCalls(calls: readonly LocatedCall[], cwd: string, max = MAX_CALL_LINES): string[] {
	const lines = calls
		.slice(0, max)
		.map(
			(call) =>
				`${call.kind} ${call.name}  ${displayPath(call.path, cwd)}:${call.line}:${call.column}` +
				(call.preview ? `  ${call.preview}` : ""),
		)
	if (calls.length > max) {
		lines.push(`+${calls.length - max} more`)
	}
	return lines
}

/**
 * `line:col  severity  message (source code)`, errors before warnings and each
 * group in line order, capped. A multi-line message keeps its lines joined.
 */
export function formatDiagnostics(diagnostics: readonly CodeDiagnostic[], max = MAX_DIAGNOSTIC_LINES): string[] {
	const rank = (diagnostic: CodeDiagnostic) => (diagnostic.severity === "error" ? 0 : 1)
	const sorted = [...diagnostics].sort((a, b) => rank(a) - rank(b) || a.line - b.line || a.column - b.column)
	const lines = sorted.slice(0, max).map((diagnostic) => {
		let message = diagnostic.message.trim().replace(/\s+/g, " ")
		if (message.length > MAX_DIAGNOSTIC_CHARS) {
			message = `${message.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`
		}
		const origin = [diagnostic.source, diagnostic.code].filter(Boolean).join(" ")
		return `${diagnostic.line}:${diagnostic.column}  ${diagnostic.severity}  ${message}${origin ? ` (${origin})` : ""}`
	})
	if (sorted.length > max) {
		lines.push(`+${sorted.length - max} more`)
	}
	return lines
}

/**
 * Errors across the workspace, grouped by file: the files with the most errors
 * first (ties in path order), each as `path (N errors)` followed by its first
 * errors indented under it and `  +N more`, then `+N more files with M errors`
 * for the files that do not fit.
 */
export function formatWorkspaceErrors(
	files: readonly CodeFileDiagnostics[],
	cwd: string,
	maxFiles = MAX_WORKSPACE_ERROR_FILES,
	maxPerFile = MAX_WORKSPACE_ERRORS_PER_FILE,
): string[] {
	const sorted = files
		.filter((file) => file.diagnostics.length > 0)
		.map((file) => ({ ...file, shown: displayPath(file.path, cwd) }))
		.sort((a, b) => b.diagnostics.length - a.diagnostics.length || a.shown.localeCompare(b.shown))
	const lines: string[] = []
	for (const file of sorted.slice(0, maxFiles)) {
		lines.push(`${file.shown} (${countOf(file.diagnostics.length, "error")})`)
		lines.push(...formatDiagnostics(file.diagnostics, maxPerFile).map((line) => `  ${line}`))
	}
	const rest = sorted.slice(maxFiles)
	if (rest.length > 0) {
		const errors = rest.reduce((total, file) => total + file.diagnostics.length, 0)
		lines.push(`+${countOf(rest.length, "more file")} with ${countOf(errors, "error")}`)
	}
	return lines
}

/** A file's edits keyed by the line they start on, in line order. */
export function groupEditsByLine(edits: readonly CodeTextEdit[]): Map<number, CodeTextEdit[]> {
	const byLine = new Map<number, CodeTextEdit[]>()
	for (const edit of [...edits].sort((a, b) => a.line - b.line || a.column - b.column)) {
		const list = byLine.get(edit.line)
		if (list) {
			list.push(edit)
		} else {
			byLine.set(edit.line, [edit])
		}
	}
	return byLine
}

/**
 * The line as it would read after the edits that start on it. An edit that
 * reaches past the line replaces the rest of it with the first line of its
 * new text, which is enough for a preview.
 */
export function applyLineEdits(lineText: string, edits: readonly CodeTextEdit[]): string {
	let result = lineText
	for (const edit of [...edits].sort((a, b) => b.column - a.column)) {
		const start = Math.max(0, edit.column - 1)
		const end = edit.endLine === edit.line ? Math.max(start, edit.endColumn - 1) : lineText.length
		result = result.slice(0, start) + edit.newText.split(/\r?\n/)[0] + result.slice(end)
	}
	return result
}

export interface RenameFilePreview {
	path: string
	/** Text edits in the file. */
	edits: number
	/** Distinct lines the edits start on. */
	changedLines: number
	/** The first changed lines, at most `MAX_RENAME_LINES_PER_FILE`. */
	lines: { line: number; before: string; after: string }[]
}

/**
 * Per file `path: N edits`, then `  - line 12: old text → new text` for its
 * first changed lines and a count of the rest. `totalFiles` counts the files
 * left out of `files`.
 */
export function formatRenamePreview(files: readonly RenameFilePreview[], totalFiles: number, cwd: string): string[] {
	const lines: string[] = []
	for (const file of files) {
		lines.push(`${displayPath(file.path, cwd)}: ${countOf(file.edits, "edit")}`)
		for (const line of file.lines) {
			lines.push(`  - line ${line.line}: ${line.before} → ${line.after}`)
		}
		if (file.changedLines > file.lines.length) {
			lines.push(`  +${countOf(file.changedLines - file.lines.length, "more line")}`)
		}
	}
	if (totalFiles > files.length) {
		lines.push(`+${countOf(totalFiles - files.length, "more file")}`)
	}
	return lines
}
