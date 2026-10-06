import { stripAnsi } from "./ansiUtils"

/**
 * Marks a continuation row while escape codes are stripped. U+FFFF is a
 * noncharacter, so it never appears in real output.
 */
const MARK = "￿"

/** "\r\n", any escape sequences, then a cursor move to `row;column`. */
const CONTINUATION = /\r\n((?:\x1b\[[0-9;?]*[A-Za-z])*?)\x1b\[\d+;(\d+)H/g

/** A chunk that ends where a continuation could still be arriving. */
const PENDING_TAIL = /\r(?:\n(?:\x1b\[[0-9;?]*[A-Za-z])*(?:\x1b(?:\[[0-9;?]*)?)?)?$/

/**
 * A row's last character, the line break, the mark carrying the cursor's
 * column, and that character again.
 */
const SOFT_WRAP = new RegExp(`([^\\n${MARK}])\\r?\\n${MARK}(\\d+)${MARK}\\1`, "g")

/** A mark where the character did not repeat: a real line break. */
const UNUSED_MARK = new RegExp(`${MARK}\\d+${MARK}`, "g")

/**
 * Turns raw terminal output into plain text, joining back the rows ConPTY
 * splits a long line into.
 *
 * On Windows, terminal output passes through ConPTY, which repaints the screen
 * instead of passing the program's bytes through. When a line wider than the
 * terminal reaches the bottom row, ConPTY writes the part that fits, "\r\n" to
 * scroll, then moves the cursor back to the last column of the row it just
 * left and writes that row's last character again before going on:
 *
 *     …run_target_cases_2026100\r\n\x1b[29;33H06_124919 set up to track…
 *
 * Stripping the escape codes alone leaves a hard line break and a doubled
 * character, so a narrow terminal handed the model `…_2026100` / `06_124919`
 * for `…_20261006_124919` and it went looking in a directory that did not
 * exist. A cursor move right after a line break is only treated as a
 * continuation when the character after it repeats the one before the break.
 *
 * The column of that cursor move is the terminal's width, which the VS Code
 * API does not expose for shell terminals; {@link columns} reports it.
 *
 * Output arrives in chunks, so a chunk ending in "\r", "\r\n" or a partial
 * escape sequence is held back until the next one, or until {@link flush}.
 */
export class ConptyWrapJoiner {
	private pending = ""
	private lastChar = ""
	private wrapColumn: number | undefined

	/** The terminal's width, once a wrapped line has shown it. */
	get columns(): number | undefined {
		return this.wrapColumn
	}

	/** Takes a chunk of raw terminal output and returns it as plain text. */
	push(raw: string): string {
		let data = this.pending + raw
		const tail = PENDING_TAIL.exec(data)
		this.pending = tail ? tail[0] : ""
		if (tail) {
			data = data.slice(0, tail.index)
		}
		return this.process(data)
	}

	/** Returns whatever was held back; call when the output has ended. */
	flush(): string {
		const data = this.pending
		this.pending = ""
		return this.process(data)
	}

	private process(data: string): string {
		if (!data) {
			return ""
		}
		const marked = data.replace(CONTINUATION, (match, between: string, column: string) =>
			Number(column) > 1 ? `\r\n${between}${MARK}${column}${MARK}` : match,
		)
		const text = (this.lastChar + stripAnsi(marked))
			.replace(SOFT_WRAP, (_match, char: string, column: string) => {
				this.wrapColumn = Number(column)
				return char
			})
			.slice(this.lastChar.length)
			.replace(UNUSED_MARK, "")
		if (text) {
			this.lastChar = text.at(-1) ?? ""
		}
		return text
	}
}
