/**
 * True when a long reply is mostly one short unit repeated — " .   .   .",
 * "]]]]" — or ends in the same sentence or paragraph over and over, which is a
 * broken generation, not an answer.
 */
export function looksDegenerate(text: string, minChars = 2000): boolean {
	if (text.length < minChars) {
		return false;
	}
	const tail = text.slice(-1500).replace(/\s+/g, " ");
	if (/(.{1,8}?)\1{30,}\s*$/.test(tail)) {
		return true;
	}
	const size = 8;
	const grams = new Set<string>();
	for (let index = 0; index + size <= tail.length; index += 1) {
		grams.add(tail.slice(index, index + size));
	}
	if (grams.size / Math.max(1, tail.length - size + 1) < 0.05) {
		return true;
	}
	return endsInRepeatedChunk(text);
}

/** Longest repeated chunk {@link endsInRepeatedChunk} looks for, in characters. */
const MAX_REPEATED_CHUNK = 1500;
/** A chunk must repeat at least this many times back to back... */
const MIN_CHUNK_REPEATS = 4;
/** ...and the repeats must cover at least this many characters. */
const MIN_REPEATED_SPAN = 800;

/**
 * True when the text ends in one chunk of 9–1 500 characters repeated back to
 * back, such as a model that says "I found the problem: … Let me create a
 * temporary script." hundreds of times instead of making the tool call. The
 * 8-gram check in {@link looksDegenerate} misses these: a 250-character
 * sentence repeated still looks varied inside a 1 500-character window.
 *
 * The text is periodic from some point on, so it works whether the stream
 * stopped at the end of a repeat or in the middle of one. Whitespace is
 * collapsed first, since models vary the spaces between repeats.
 */
function endsInRepeatedChunk(text: string): boolean {
	const tail = text
		.slice(-(MAX_REPEATED_CHUNK * MIN_CHUNK_REPEATS + 500))
		.replace(/\s+/g, " ")
		.trimEnd();
	const anchor = tail.slice(-24);
	if (anchor.length < 24) {
		return false;
	}
	// Every earlier occurrence of the last few characters is a candidate period.
	let from = tail.length - anchor.length - 1;
	while (from >= 0) {
		const at = tail.lastIndexOf(anchor, from);
		if (at < 0) {
			return false;
		}
		const period = tail.length - anchor.length - at;
		if (period > MAX_REPEATED_CHUNK) {
			return false;
		}
		const span = Math.max(period * MIN_CHUNK_REPEATS, MIN_REPEATED_SPAN);
		if (
			period > 8 &&
			span <= tail.length &&
			tail.slice(-span + period) === tail.slice(-span, -period)
		) {
			return true;
		}
		from = at - 1;
	}
	return false;
}
