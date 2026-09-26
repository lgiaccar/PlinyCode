/**
 * File-path detection for chat markdown. Candidates are only *potential*
 * paths: the webview asks the extension whether each one exists before it
 * renders an "open in editor" link.
 */

// Relative forward-slash path: `src/foo.ts`, `README.md`.
const RELATIVE_POSIX_PATH = /^(?!\/)[\w\-./]+(?<!\/)$/
// Relative backslash path: `src\foo.ts`.
const RELATIVE_WINDOWS_PATH = /^[\w\-.]+(?:\\[\w\-. ]+)+$/
// Absolute Windows path, either separator, any drive-letter case: `d:\dev\x.md`, `C:/x/y.ts`.
const ABSOLUTE_WINDOWS_PATH = /^[A-Za-z]:[\\/][^<>"|?*\n]*[^<>"|?*\n\\/ ]$/
// Absolute POSIX path with at least two segments: `/home/me/x.md`.
const ABSOLUTE_POSIX_PATH = /^\/[\w\-. ]+(?:\/[\w\-. ]+)+$/

/** Whether the contents of an inline code span look like a file path. */
export function isPotentialFilePath(value: string): boolean {
	if (!value || value.includes("\n")) {
		return false
	}
	return (
		RELATIVE_POSIX_PATH.test(value) ||
		RELATIVE_WINDOWS_PATH.test(value) ||
		ABSOLUTE_WINDOWS_PATH.test(value) ||
		ABSOLUTE_POSIX_PATH.test(value)
	)
}

// Absolute paths in plain prose. Spaces end a path here, since prose gives no
// delimiter; paths with spaces still work inside backticks. POSIX paths need a
// file extension so prose such as "and/or" or "/api/v1" is left alone.
const TEXT_PATH_REGEX = /(?<![\w/\\])(?:[A-Za-z]:[\\/][^\s<>"'`|?*]+|\/(?:[\w\-.]+\/)+[\w-]+\.[A-Za-z0-9]+)(?![\w/\\])/g
// Sentence punctuation a path in prose is usually followed by.
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/

export type TextSegment = { type: "text"; value: string } | { type: "path"; value: string }

/**
 * Splits prose into text and absolute-path segments. Returns undefined when
 * the text contains no path, so callers can leave the node untouched.
 */
export function splitTextFilePaths(text: string): TextSegment[] | undefined {
	const segments: TextSegment[] = []
	let last = 0
	for (const match of text.matchAll(TEXT_PATH_REGEX)) {
		let path = match[0]
		const trailing = TRAILING_PUNCTUATION.exec(path)?.[0] ?? ""
		path = path.slice(0, path.length - trailing.length)
		if (!/[\\/]./.test(path.slice(path.search(/[\\/]/)))) {
			continue // a bare drive like "C:\" is not a file
		}
		const start = match.index ?? 0
		if (start > last) {
			segments.push({ type: "text", value: text.slice(last, start) })
		}
		segments.push({ type: "path", value: path })
		last = start + path.length
	}
	if (segments.length === 0) {
		return undefined
	}
	if (last < text.length) {
		segments.push({ type: "text", value: text.slice(last) })
	}
	return segments
}
