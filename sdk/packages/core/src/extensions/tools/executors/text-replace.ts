/**
 * Text replacement for the editor tool.
 *
 * Kept free of filesystem access so a host that previews an edit before it is
 * written (the VS Code diff preview) runs the same matching as the executor
 * that writes it, and the preview cannot disagree with the write.
 */

import { detectLineEnding, normalizeLineEndings } from "./line-endings";

export interface ReplaceTextOptions {
	/** Shown in error messages. */
	filePath: string;
	/** Replace every exact occurrence instead of requiring exactly one. */
	replaceAll?: boolean | null;
}

export interface ReplaceTextResult {
	updated: string;
	/** One-based line of each replaced occurrence, in file order. */
	replacedAtLines: number[];
	/**
	 * Set when `old_text` did not match exactly but did match once after
	 * ignoring indentation depth or trailing whitespace.
	 */
	whitespaceAdjusted?: "trailing" | "reindented";
}

/** Lines of the file quoted back in a not-found error. */
const MAX_CLOSEST_REGION_LINES = 40;
/** Characters kept per quoted line. */
const MAX_QUOTED_LINE_CHARS = 300;
/** Occurrence line numbers listed in a multiple-match error. */
const MAX_LISTED_OCCURRENCES = 10;
/** A line repeated more often than this says nothing about where a block is. */
const MAX_VOTING_LINE_REPEATS = 50;
/** Share of the non-blank `old_text` lines a region must contain to be quoted. */
const MIN_CLOSEST_REGION_MATCH_RATIO = 0.4;
/** Similarity a single line needs to be quoted when no line matches outright. */
const MIN_SIMILAR_LINE_SCORE = 0.6;
/** Files longer than this skip the per-line similarity scan. */
const MAX_SIMILARITY_SCAN_LINES = 20_000;

interface FileLine {
	text: string;
	/** Offset of the first character of the line. */
	start: number;
	/** Offset just past the line's text, before its line break. */
	end: number;
	/** Offset just past the line break, or `end` on a last line without one. */
	endWithBreak: number;
}

function splitFileLines(content: string): FileLine[] {
	const lines: FileLine[] = [];
	let start = 0;
	while (start <= content.length) {
		const newline = content.indexOf("\n", start);
		if (newline === -1) {
			lines.push({
				text: content.slice(start),
				start,
				end: content.length,
				endWithBreak: content.length,
			});
			break;
		}
		const end =
			newline > start && content[newline - 1] === "\r" ? newline - 1 : newline;
		lines.push({
			text: content.slice(start, end),
			start,
			end,
			endWithBreak: newline + 1,
		});
		start = newline + 1;
	}
	return lines;
}

function leadingWhitespace(line: string): string {
	return line.slice(0, line.length - line.trimStart().length);
}

function exactOccurrenceOffsets(content: string, needle: string): number[] {
	const offsets: number[] = [];
	if (needle.length === 0) {
		return offsets;
	}
	let from = 0;
	while (true) {
		const index = content.indexOf(needle, from);
		if (index === -1) {
			return offsets;
		}
		offsets.push(index);
		from = index + needle.length;
	}
}

function lineNumberAt(content: string, offset: number): number {
	let line = 1;
	for (let index = content.indexOf("\n"); index !== -1 && index < offset; ) {
		line++;
		index = content.indexOf("\n", index + 1);
	}
	return line;
}

function formatLineList(lines: number[]): string {
	const listed = lines.slice(0, MAX_LISTED_OCCURRENCES).join(", ");
	const rest = lines.length - MAX_LISTED_OCCURRENCES;
	return rest > 0 ? `${listed} and ${rest} more` : listed;
}

interface IndentShift {
	kind: "none" | "add" | "remove";
	prefix: string;
}

/**
 * How the file's indentation differs from `old_text`'s over one window, when
 * the difference is the same on every line: the file is indented deeper by a
 * fixed prefix, or shallower by one. Undefined when the lines differ in any
 * other way (tabs against spaces, or a different shift per line), because
 * then there is no safe way to re-indent `new_text`.
 */
function indentShiftForWindow(
	fileLines: FileLine[],
	start: number,
	oldLines: string[],
): IndentShift | undefined {
	let shift: IndentShift | undefined;
	for (let offset = 0; offset < oldLines.length; offset++) {
		const fileLine = fileLines[start + offset].text;
		const oldLine = oldLines[offset];
		if (fileLine.trim() !== oldLine.trim()) {
			return undefined;
		}
		if (oldLine.trim().length === 0) {
			continue;
		}
		const fileIndent = leadingWhitespace(fileLine);
		const oldIndent = leadingWhitespace(oldLine);
		if (!shift) {
			if (fileIndent === oldIndent) {
				shift = { kind: "none", prefix: "" };
			} else if (fileIndent.endsWith(oldIndent)) {
				shift = {
					kind: "add",
					prefix: fileIndent.slice(0, fileIndent.length - oldIndent.length),
				};
			} else if (oldIndent.endsWith(fileIndent)) {
				shift = {
					kind: "remove",
					prefix: oldIndent.slice(0, oldIndent.length - fileIndent.length),
				};
			} else {
				return undefined;
			}
			continue;
		}
		const expected =
			shift.kind === "add"
				? fileIndent === shift.prefix + oldIndent
				: shift.kind === "remove"
					? oldIndent === shift.prefix + fileIndent
					: fileIndent === oldIndent;
		if (!expected) {
			return undefined;
		}
	}
	return shift;
}

function applyIndentShift(text: string, shift: IndentShift): string {
	if (shift.kind === "none") {
		return text;
	}
	return text
		.split(/(\r\n|\n)/)
		.map((part) => {
			if (part === "\n" || part === "\r\n" || part.trim().length === 0) {
				return part;
			}
			if (shift.kind === "add") {
				return shift.prefix + part;
			}
			return part.startsWith(shift.prefix)
				? part.slice(shift.prefix.length)
				: part;
		})
		.join("");
}

interface WhitespaceMatch {
	start: number;
	shift: IndentShift;
}

/**
 * Windows of whole file lines that equal `old_text`'s lines once indentation
 * depth and trailing whitespace are set aside.
 */
function findWhitespaceMatches(
	fileLines: FileLine[],
	oldLines: string[],
): WhitespaceMatch[] {
	const matches: WhitespaceMatch[] = [];
	if (oldLines.every((line) => line.trim().length === 0)) {
		return matches;
	}
	const firstTrimmed = oldLines[0].trim();
	for (let start = 0; start + oldLines.length <= fileLines.length; start++) {
		if (fileLines[start].text.trim() !== firstTrimmed) {
			continue;
		}
		const shift = indentShiftForWindow(fileLines, start, oldLines);
		if (shift) {
			matches.push({ start, shift });
		}
	}
	return matches;
}

function bigrams(text: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (let index = 0; index < text.length - 1; index++) {
		const pair = text.slice(index, index + 2);
		counts.set(pair, (counts.get(pair) ?? 0) + 1);
	}
	return counts;
}

/** Dice coefficient over character bigrams, 0 to 1. */
function similarity(
	target: Map<string, number>,
	targetSize: number,
	candidate: string,
): number {
	const candidateSize = candidate.length - 1;
	if (targetSize <= 0 || candidateSize <= 0) {
		return 0;
	}
	const remaining = new Map(target);
	let shared = 0;
	for (let index = 0; index < candidate.length - 1; index++) {
		const pair = candidate.slice(index, index + 2);
		const left = remaining.get(pair);
		if (left) {
			shared++;
			remaining.set(pair, left - 1);
		}
	}
	return (2 * shared) / (targetSize + candidateSize);
}

interface ClosestRegion {
	/** Zero-based index of the file line aligned with `old_text`'s first line. */
	start: number;
	/** Non-blank `old_text` lines found at their place in the region. */
	matchedLines: number;
}

/**
 * Where in the file `old_text` most plausibly meant to point. Each non-blank
 * `old_text` line that also appears in the file votes for the window start
 * that would put it in place; the window with the most votes wins. When no
 * line matches outright (a one-line `old_text` with a typo, say), the single
 * most similar line is used instead.
 */
function findClosestRegion(
	fileLines: FileLine[],
	oldLines: string[],
): ClosestRegion | undefined {
	const fileIndex = new Map<string, number[]>();
	for (let index = 0; index < fileLines.length; index++) {
		const trimmed = fileLines[index].text.trim();
		if (trimmed.length === 0) {
			continue;
		}
		const seen = fileIndex.get(trimmed);
		if (seen) {
			seen.push(index);
		} else {
			fileIndex.set(trimmed, [index]);
		}
	}

	const votes = new Map<number, number>();
	let nonBlank = 0;
	for (let offset = 0; offset < oldLines.length; offset++) {
		const trimmed = oldLines[offset].trim();
		if (trimmed.length === 0) {
			continue;
		}
		nonBlank++;
		const places = fileIndex.get(trimmed);
		if (!places || places.length > MAX_VOTING_LINE_REPEATS) {
			continue;
		}
		for (const place of places) {
			const start = place - offset;
			votes.set(start, (votes.get(start) ?? 0) + 1);
		}
	}

	let best: ClosestRegion | undefined;
	for (const [start, matchedLines] of votes) {
		if (
			!best ||
			matchedLines > best.matchedLines ||
			(matchedLines === best.matchedLines && start < best.start)
		) {
			best = { start, matchedLines };
		}
	}
	if (
		best &&
		best.matchedLines >= Math.ceil(nonBlank * MIN_CLOSEST_REGION_MATCH_RATIO)
	) {
		return best;
	}

	if (fileLines.length > MAX_SIMILARITY_SCAN_LINES) {
		return undefined;
	}
	const anchorOffset = oldLines.findIndex((line) => line.trim().length > 0);
	if (anchorOffset === -1) {
		return undefined;
	}
	const anchor = oldLines[anchorOffset].trim();
	const anchorBigrams = bigrams(anchor);
	let bestScore = 0;
	let bestLine = -1;
	for (let index = 0; index < fileLines.length; index++) {
		const candidate = fileLines[index].text.trim();
		// A fragment of a line scores low on similarity but is still the place.
		const score = candidate.includes(anchor)
			? 1
			: similarity(anchorBigrams, anchor.length - 1, candidate);
		if (score > bestScore) {
			bestScore = score;
			bestLine = index;
		}
	}
	if (bestLine === -1 || bestScore < MIN_SIMILAR_LINE_SCORE) {
		return undefined;
	}
	return { start: bestLine - anchorOffset, matchedLines: 0 };
}

function quoteLine(line: string): string {
	return line.length > MAX_QUOTED_LINE_CHARS
		? `${line.slice(0, MAX_QUOTED_LINE_CHARS)}…`
		: line;
}

function describeFirstDifference(
	fileLines: FileLine[],
	region: ClosestRegion,
	oldLines: string[],
): string | undefined {
	for (let offset = 0; offset < oldLines.length; offset++) {
		const fileLine = fileLines[region.start + offset]?.text;
		const oldLine = oldLines[offset];
		if (fileLine === oldLine) {
			continue;
		}
		const lineNumber = region.start + offset + 1;
		if (fileLine === undefined) {
			return `old_text continues past the end of the file (which has ${fileLines.length} lines).`;
		}
		// JSON quoting makes a tab-against-spaces or trailing-space difference visible.
		const whitespaceOnly = fileLine.trim() === oldLine.trim();
		const show = (line: string) =>
			whitespaceOnly ? JSON.stringify(quoteLine(line)) : quoteLine(line);
		return (
			`First difference, at line ${lineNumber}${whitespaceOnly ? " (whitespace only)" : ""}:\n` +
			`  in the file: ${show(fileLine)}\n` +
			`  in old_text: ${show(oldLine)}`
		);
	}
	return undefined;
}

function notFoundMessage(
	filePath: string,
	fileLines: FileLine[],
	oldLines: string[],
	whitespaceMatches: WhitespaceMatch[],
): string {
	const base = `No replacement performed: text not found in ${filePath}.`;
	if (whitespaceMatches.length > 1) {
		const lines = whitespaceMatches.map((match) => match.start + 1);
		return `${base} Ignoring indentation, old_text matches at ${whitespaceMatches.length} places (lines ${formatLineList(lines)}). Add surrounding lines to old_text so that it matches exactly one of them.`;
	}

	const region = findClosestRegion(fileLines, oldLines);
	if (!region) {
		return `${base} Nothing similar to old_text is in the file: the file may have changed since it was read, or this may be the wrong file. Read the file again before retrying.`;
	}

	const first = Math.max(0, region.start);
	const last = Math.min(
		fileLines.length - 1,
		region.start + oldLines.length - 1,
		first + MAX_CLOSEST_REGION_LINES - 1,
	);
	const nonBlank = oldLines.filter((line) => line.trim().length > 0).length;
	const matched =
		region.matchedLines > 0
			? ` (${region.matchedLines} of ${nonBlank} old_text lines are there)`
			: "";
	const difference = describeFirstDifference(fileLines, region, oldLines);
	const quoted = fileLines
		.slice(first, last + 1)
		.map((line, index) => `${first + index + 1}: ${quoteLine(line.text)}`)
		.join("\n");
	return [
		`${base} The closest text is at lines ${first + 1}-${last + 1}${matched}.`,
		...(difference ? [difference] : []),
		`Lines ${first + 1}-${last + 1} of the file now:`,
		quoted,
		"Copy old_text exactly from these lines and retry. Do not re-send the same old_text.",
	].join("\n");
}

/**
 * Replace `oldText` with `newText` in `content`.
 *
 * An exact match is used when there is exactly one (or, with `replaceAll`,
 * at least one). Otherwise, when `old_text` matches whole lines at exactly
 * one place apart from indentation depth or trailing whitespace, that place
 * is replaced and `new_text` is shifted to the file's indentation. Anything
 * else throws, with a message that says where the closest text is and what
 * differs, so that the next attempt is not a guess.
 */
export function replaceTextInContent(
	content: string,
	oldText: string,
	newText: string | null | undefined,
	options: ReplaceTextOptions,
): ReplaceTextResult {
	const eol = detectLineEnding(content);
	const normalizedOld = normalizeLineEndings(oldText, eol);
	const normalizedNew = normalizeLineEndings(newText ?? "", eol);
	const offsets = exactOccurrenceOffsets(content, normalizedOld);

	if (offsets.length === 1 || (offsets.length > 1 && options.replaceAll)) {
		return {
			// split/join inserts "$"-sequences in new_text ($&, $', $`, $$, $n)
			// literally, where String.replace with a string would expand them.
			updated: content.split(normalizedOld).join(normalizedNew),
			replacedAtLines: offsets.map((offset) => lineNumberAt(content, offset)),
		};
	}

	if (offsets.length > 1) {
		const lines = offsets.map((offset) => lineNumberAt(content, offset));
		throw new Error(
			`No replacement performed: multiple occurrences of text found in ${options.filePath}. old_text matches at ${offsets.length} places (lines ${formatLineList(lines)}). Add surrounding lines to old_text so that it matches exactly one, or set replace_all to true to replace all of them.`,
		);
	}

	if (normalizedOld.length === 0) {
		throw new Error(
			`No replacement performed: text not found in ${options.filePath}. old_text is empty; set it to the exact text to replace, or use insert_line to insert.`,
		);
	}

	const fileLines = splitFileLines(content);
	const oldLines = oldText.split(/\r\n|\n/);
	// An old_text ending in a line break covers its last line's break too.
	const coversFinalBreak = oldLines.length > 1 && oldLines.at(-1) === "";
	if (coversFinalBreak) {
		oldLines.pop();
	}

	const whitespaceMatches = findWhitespaceMatches(fileLines, oldLines);
	if (whitespaceMatches.length !== 1) {
		throw new Error(
			notFoundMessage(options.filePath, fileLines, oldLines, whitespaceMatches),
		);
	}

	const [match] = whitespaceMatches;
	const lastLine = fileLines[match.start + oldLines.length - 1];
	const start = fileLines[match.start].start;
	const end = coversFinalBreak ? lastLine.endWithBreak : lastLine.end;
	return {
		updated:
			content.slice(0, start) +
			applyIndentShift(normalizedNew, match.shift) +
			content.slice(end),
		replacedAtLines: [match.start + 1],
		whitespaceAdjusted: match.shift.kind === "none" ? "trailing" : "reindented",
	};
}
