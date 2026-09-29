// Pure input-parsing helpers for SDK tool inputs, shared by tool-mapping.ts.
// Split out of message-translator.ts (see message-translator/index.ts).

import { PATCH_MARKERS } from "@plinycode/core"
import type { ClineSayTool } from "@shared/ExtensionMessage"

/**
 * Parse tool input into a record if it's a string or object.
 */
export function parseToolInput(input: unknown): Record<string, unknown> | undefined {
	if (!input) return undefined
	if (typeof input === "object" && !Array.isArray(input)) {
		return input as Record<string, unknown>
	}
	if (typeof input === "string") {
		try {
			const parsed = JSON.parse(input)
			if (typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed
			}
		} catch {
			// Not JSON — return undefined
		}
	}
	return undefined
}

/** A single file read request parsed from a read_files/read_file input */
interface FileReadRequest {
	path: string
	startLine?: number
	endLine?: number
}

/** Extract file read requests (path + optional one-based inclusive line range) from a read_files/read_file input */
export function extractFileReads(input: Record<string, unknown> | undefined): FileReadRequest[] {
	if (!input) return []
	const files = input.files
	if (Array.isArray(files) && files.length > 0) {
		const reads = files
			.map((f): FileReadRequest => {
				if (typeof f === "string") return { path: f }
				if (typeof f === "object" && f !== null) {
					const entry = f as Record<string, unknown>
					return {
						path: (entry.path as string) ?? "",
						startLine: getNumberField(entry, "start_line"),
						endLine: getNumberField(entry, "end_line"),
					}
				}
				return { path: "" }
			})
			.filter((read) => read.path)
		if (reads.length > 0) {
			return reads
		}
	}
	const singlePath =
		(input.path as string) ?? (input.file_path as string) ?? (input.filePath as string) ?? (input.filename as string) ?? ""
	return singlePath
		? [{ path: singlePath, startLine: getNumberField(input, "start_line"), endLine: getNumberField(input, "end_line") }]
		: []
}

/**
 * Map a read request's line range onto ClineSayTool fields. An omitted start_line with an
 * explicit end_line means the read began at line 1; an omitted end_line stays undefined
 * (open-ended read — the UI renders it as "start+").
 */
export function readLineRangeFields(read: FileReadRequest | undefined): Pick<ClineSayTool, "readLineStart" | "readLineEnd"> {
	if (!read || (read.startLine == null && read.endLine == null)) {
		return {}
	}
	return { readLineStart: read.startLine ?? 1, readLineEnd: read.endLine }
}

/** Get a string field from a parsed input object */
export function getStringField(input: Record<string, unknown> | undefined, field: string): string | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "string") return value
	return undefined
}

/** Get a finite number field from a parsed input object (null/non-number → undefined) */
export function getNumberField(input: Record<string, unknown> | undefined, field: string): number | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "number" && Number.isFinite(value)) return value
	return undefined
}

export function getApplyPatchString(input: unknown): string | undefined {
	const parsed = parseToolInput(input)
	const fromFields = getStringField(parsed, "patch") ?? getStringField(parsed, "diff") ?? getStringField(parsed, "input")
	if (fromFields !== undefined) {
		return fromFields
	}
	return typeof input === "string" ? input : undefined
}

/**
 * Split a multi-file apply_patch string into one ClineSayTool per file so each
 * "Cline wants to edit this file" row renders only that file's diff (cline#9904).
 *
 * Returns [] for single-file (or unparseable) patches so callers keep the existing
 * single-message behavior — only genuinely multi-file patches are split.
 */
export function splitApplyPatchByFile(patch: string): ClineSayTool[] {
	const lines = patch.split("\n")
	const blocks: { tool: ClineSayTool["tool"]; path: string; lines: string[] }[] = []
	let current: { tool: ClineSayTool["tool"]; path: string; lines: string[] } | undefined

	for (const line of lines) {
		if (line === PATCH_MARKERS.END) {
			break
		}
		const marker = [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE].find((m) => line.startsWith(m))
		if (marker) {
			if (current) {
				blocks.push(current)
			}
			const tool: ClineSayTool["tool"] =
				marker === PATCH_MARKERS.ADD
					? "newFileCreated"
					: marker === PATCH_MARKERS.DELETE
						? "fileDeleted"
						: "editedExistingFile"
			current = { tool, path: line.substring(marker.length).trim(), lines: [line] }
		} else if (current) {
			current.lines.push(line)
		}
	}
	if (current) {
		blocks.push(current)
	}

	// Only split genuine multi-file patches. Bail out (→ single whole-patch
	// message) if fewer than two files, or if any block has an empty path — a
	// pathless row can't route to the per-file diff view (cline#9904).
	if (blocks.length < 2 || blocks.some((block) => block.path === "")) {
		return []
	}

	return blocks.map((block) => {
		if (block.tool === "fileDeleted") {
			return { tool: block.tool, path: block.path }
		}
		const subPatch = [PATCH_MARKERS.BEGIN, ...block.lines, PATCH_MARKERS.END].join("\n")
		return { tool: block.tool, path: block.path, content: subPatch, diff: subPatch }
	})
}

/** Get an array field from a parsed input object */
export function getArrayField(input: Record<string, unknown> | undefined, field: string): string[] | undefined {
	if (!input) return undefined
	const value = input[field]
	if (Array.isArray(value)) return value.map(String)
	return undefined
}

export function formatStructuredCommand(command: unknown): string {
	if (typeof command === "string") return command
	if (command && typeof command === "object" && !Array.isArray(command)) {
		const record = command as Record<string, unknown>
		if (typeof record.command === "string") {
			const args = Array.isArray(record.args) ? record.args.map(String) : []
			return args.length > 0 ? `${record.command} ${args.join(" ")}` : record.command
		}
	}
	return String(command)
}

export function getCommandArrayField(input: Record<string, unknown> | undefined, field: string): string[] | undefined {
	if (!input) return undefined
	const value = input[field]
	if (Array.isArray(value)) return value.map(formatStructuredCommand)
	return undefined
}

/** Get a boolean field from a parsed input object */
export function getBooleanField(input: Record<string, unknown> | undefined, field: string): boolean | undefined {
	if (!input) return undefined
	const value = input[field]
	if (typeof value === "boolean") return value
	return undefined
}
