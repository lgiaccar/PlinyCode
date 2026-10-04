/**
 * Text replacement for the editor tool.
 *
 * Kept free of filesystem access so a host that previews an edit before it is
 * written (the VS Code diff preview) runs the same matching as the executor
 * that writes it, and the preview cannot disagree with the write.
 */

import { detectLineEnding, normalizeLineEndings } from "./line-endings";

function countOccurrences(content: string, needle: string): number {
	if (needle.length === 0) return 0;
	return content.split(needle).length - 1;
}

/**
 * Replace the single occurrence of `oldText` in `content` with `newText`.
 *
 * Reads strip "\r", so models emit LF-only text even for CRLF files; both
 * texts are normalized to the file's own line ending before matching, or a
 * multi-line `oldText` would never match in a CRLF file and the edit would
 * leave mixed endings behind. Throws when `oldText` is absent or ambiguous;
 * `filePath` only appears in those messages.
 */
export function replaceTextInContent(
	content: string,
	oldText: string,
	newText: string | null | undefined,
	filePath: string,
): string {
	const eol = detectLineEnding(content);
	const normalizedOld = normalizeLineEndings(oldText, eol);
	const normalizedNew = normalizeLineEndings(newText ?? "", eol);
	const occurrences = countOccurrences(content, normalizedOld);

	if (occurrences === 0) {
		throw new Error(`No replacement performed: text not found in ${filePath}.`);
	}

	if (occurrences > 1) {
		throw new Error(
			`No replacement performed: multiple occurrences of text found in ${filePath}.`,
		);
	}

	// Replacer function so "$"-sequences in new_text ($&, $', $`, $$, $n)
	// are inserted literally instead of being expanded by String.replace.
	return content.replace(normalizedOld, () => normalizedNew);
}
