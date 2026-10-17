/**
 * Pure helpers for the code intelligence tools: finding where a symbol sits in
 * a document, reducing hover markdown, and laying results out in as few
 * tokens as a model needs to act on them.
 */

import * as path from "path"
import type { CodeHover, CodeLocation, CodeSymbol } from "./code-intel-source"

/** How many result lines a navigation answer shows before summarising the rest. */
export const MAX_RESULT_LINES = 30
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
