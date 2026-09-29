/**
 * Size limits for content pasted into a message through @-mentions. Mentioned
 * content becomes part of the user message and is resent with every request
 * until the conversation is compacted, so these stay well below a context
 * window: the model can read more with its tools when it needs to.
 */

/** Maximum characters of one mentioned file (≈ 30k tokens). */
const MAX_CONTENT_SIZE_BYTES = 100_000

/** Maximum characters of all file contents of one mentioned folder together. */
export const MAX_MENTION_FOLDER_CHARS = 100_000

/** Maximum characters of one mentioned URL's page. */
export const MAX_MENTION_URL_CHARS = 50_000

/**
 * Format bytes into a human-readable string (e.g., "1.5 MB", "400 KB").
 */
function formatBytes(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Truncate content if it exceeds the maximum size limit.
 * Shows the beginning of the content with a clear truncation notice at the very end.
 *
 * @param content The content to potentially truncate
 * @param maxSize Maximum size in bytes (defaults to MAX_CONTENT_SIZE_BYTES)
 * @returns The original content if under limit, or truncated content with message at end
 */
export function truncateContent(
	content: string,
	maxSize: number = MAX_CONTENT_SIZE_BYTES,
	kind: "FILE" | "PAGE" = "FILE",
): string {
	if (content.length <= maxSize) {
		return content
	}

	const truncatedContent = content.slice(0, maxSize)
	const truncatedAmount = content.length - maxSize
	const howToReadMore =
		kind === "FILE"
			? "Use read_files with a line range, search_codebase, or run_commands with grep/head/tail to read the rest."
			: "Use fetch_web_content to read the page if you need the rest."

	return `${truncatedContent}\n\n---\n\n[${kind} TRUNCATED: This content is ${formatBytes(content.length)} but only the first ${formatBytes(maxSize)} is shown (${formatBytes(truncatedAmount)} truncated). ${howToReadMore}]`
}
