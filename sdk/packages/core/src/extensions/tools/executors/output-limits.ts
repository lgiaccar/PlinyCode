/**
 * Shared caps for how much tool output may enter the conversation. Every
 * character returned by an executor is re-sent to the model on each
 * subsequent request, so oversized outputs cost quadratically over the
 * remaining run. Limits are measured in characters (UTF-16 code units),
 * which tracks token cost more closely than bytes and is what JS strings
 * measure exactly. Executors enforce these caps; tool descriptions
 * reference them so the model pages or narrows instead of retrying.
 *
 * Truncation notices always live in the preserved head/tail of an entry,
 * never in the elided middle. Provider-request building may re-truncate
 * long strings with its own (possibly tighter) middle-cut backstop
 * (session/services/message-builder.ts); keeping the notices at the edges
 * means the recovery guidance survives that cut too.
 */

/** Max characters of command output kept; beyond this the middle is elided. */
export const MAX_COMMAND_OUTPUT_CHARS = 48_000;

export function truncateCommandOutput(
	text: string,
	options: { maxChars?: number; totalChars?: number } = {},
): string {
	const maxChars = options.maxChars ?? MAX_COMMAND_OUTPUT_CHARS;
	const totalChars = options.totalChars ?? text.length;
	if (text.length <= maxChars && totalChars <= maxChars) {
		return text;
	}

	const headLimit = Math.ceil(maxChars / 2);
	const tailLimit = Math.max(1, maxChars - headLimit);
	return (
		`${text.slice(0, headLimit)}\n` +
		`[... output truncated: ${totalChars} chars total. ` +
		"Refine the command (grep, head, tail) to view the elided middle ...]\n" +
		text.slice(-tailLimit)
	);
}

/** Max lines returned per file read when the range is larger or absent. */
export const MAX_READ_LINES = 2_000;

/** Max characters kept per line in file reads (defangs minified files). */
export const MAX_LINE_CHARS = 2_000;

/** Max characters returned per file read window. */
export const MAX_READ_OUTPUT_CHARS = 48_000;

/** Max characters returned per search query; beyond this the middle is elided. */
export const MAX_SEARCH_OUTPUT_CHARS = 48_000;

/**
 * Max characters one `search_codebase` call returns across all its queries.
 * The per-query cap alone let a call with seven queries return 224k
 * characters, a third of a 128k-token budget, in one tool result.
 */
export const MAX_SEARCH_CALL_CHARS = 32_000;

/** Max characters one `read_files` call returns across all its files. */
export const MAX_READ_CALL_CHARS = 64_000;

/**
 * Caps what a multi-entry tool call returns as a whole. Entries are kept in
 * order; the one that crosses the budget is middle-cut to what is left (never
 * below `minEntryChars`), and the ones after it are replaced by a one-line
 * note so the model knows to ask for them on their own. Entries whose result
 * is not a string (images) are left alone and not counted.
 */
export function capOperationResultsTotal<
	T extends { query: string; result: unknown },
>(
	results: T[],
	maxTotalChars: number,
	hint: string,
	minEntryChars = 2_000,
): T[] {
	let used = 0;
	let spent = false;
	return results.map((entry) => {
		if (typeof entry.result !== "string") {
			return entry;
		}
		if (spent) {
			return {
				...entry,
				result: `[result elided: this call's output budget of ${maxTotalChars} chars was spent by the earlier entries. ${hint}]`,
			};
		}
		const remaining = maxTotalChars - used;
		if (entry.result.length <= remaining) {
			used += entry.result.length;
			return entry;
		}
		spent = true;
		const keep = Math.max(minEntryChars, remaining);
		const result = truncateCommandOutput(entry.result, { maxChars: keep });
		return {
			...entry,
			result: `${result}\n[... cut to ${keep} chars: this call's output budget of ${maxTotalChars} chars is spent. ${hint}]`,
		};
	});
}

/** Command output longer than this is digested instead of returned whole. */
export const COMMAND_DIGEST_THRESHOLD_CHARS = 16_000;

const DIGEST_HEAD_CHARS = 1_500;
const DIGEST_TAIL_CHARS = 5_000;
const DIGEST_DIAGNOSTIC_CHARS = 6_000;
const DIGEST_LINE_CHARS = 400;

const DIAGNOSTIC_LINE =
	/\b(error|fatal|failed|failure|exception|panic|traceback|assertion)\b|\bC\d{4}\b|\bLNK\d{4}\b|\bTS\d{4}\b|^\s*FAIL\b|\[\s*FAILED\s*\]|npm ERR!|✗|✖/i;
const BENIGN_LINE =
	/\b0 (errors?|failed|failures)\b|\bfailed:?\s*0\b|\bno errors?\b|\berrors?:\s*0\b/i;

function clipLine(line: string): string {
	return line.length > DIGEST_LINE_CHARS
		? `${line.slice(0, DIGEST_LINE_CHARS)}...`
		: line;
}

/**
 * Shrinks a long command output to what a build or test run needs the model
 * to see: the first lines, every diagnostic line (errors, failures, compiler
 * codes) with its line number, and the tail, where the verdict usually is.
 * `savedTo` names the file holding the whole output; the notice tells the
 * model to read or search that file instead of re-running the command.
 * Output at or under the threshold comes back unchanged. The result is
 * bounded by roughly 13,000 characters however large the input.
 */
export function digestCommandOutput(
	text: string,
	options: { savedTo?: string; thresholdChars?: number } = {},
): string {
	if (
		text.length <= (options.thresholdChars ?? COMMAND_DIGEST_THRESHOLD_CHARS)
	) {
		return text;
	}
	const lines = text.split("\n");
	const keep = new Set<number>();

	let used = 0;
	let headEnd = 0;
	while (headEnd < lines.length && used < DIGEST_HEAD_CHARS) {
		used += clipLine(lines[headEnd]).length + 1;
		keep.add(headEnd);
		headEnd += 1;
	}
	used = 0;
	let tailStart = lines.length;
	while (tailStart > headEnd && used < DIGEST_TAIL_CHARS) {
		tailStart -= 1;
		used += clipLine(lines[tailStart]).length + 1;
		keep.add(tailStart);
	}

	const diagnostics: number[] = [];
	for (let index = headEnd; index < tailStart; index += 1) {
		const line = lines[index];
		if (DIAGNOSTIC_LINE.test(line) && !BENIGN_LINE.test(line)) {
			diagnostics.push(index);
		}
	}
	used = 0;
	let shownDiagnostics = 0;
	for (const index of diagnostics) {
		const cost = clipLine(lines[index]).length + 8;
		if (used + cost > DIGEST_DIAGNOSTIC_CHARS) {
			break;
		}
		used += cost;
		keep.add(index);
		shownDiagnostics += 1;
	}

	const out: string[] = [
		`[Output digest: ${lines.length} lines, ${text.length} chars. ` +
			(options.savedTo
				? `The whole output is saved to ${options.savedTo}: read it with read_files (line ranges) or search it. `
				: "") +
			`Showing the first lines, ${shownDiagnostics} of ${diagnostics.length} error/failure lines from the middle (numbered), and the last lines.]`,
	];
	let previous = -1;
	for (let index = 0; index < lines.length; index += 1) {
		if (!keep.has(index)) {
			continue;
		}
		if (index > previous + 1) {
			out.push(`[... ${index - previous - 1} lines omitted ...]`);
		}
		const inMiddle = index >= headEnd && index < tailStart;
		out.push(
			inMiddle
				? `${index + 1}: ${clipLine(lines[index])}`
				: clipLine(lines[index]),
		);
		previous = index;
	}
	if (previous < lines.length - 1) {
		out.push(`[... ${lines.length - 1 - previous} lines omitted ...]`);
	}
	return out.join("\n");
}
