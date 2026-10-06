import { describe, expect, it } from "bun:test"
import { ConptyWrapJoiner } from "./conptyWrapJoiner"

// Recorded from powershell.exe in a 33-column ConPTY (VS Code's node-pty) with
// the cursor on the bottom row, so every long line scrolls as it wraps.
const GIT_LOG =
	"babd20e54c75e40f1427a1b7d4d1efb30\r\n\u001b[29;33H034aaa8e Side questions off the re\r\n\u001b[29;33Hecord, and Plan, Agent and Ask in \r\n\u001b[29;33H their own colors (0.1.9-test.3) (\r\n\u001b[29;33H(#114) lgiaccar Mon Oct 5 19:16:04\r\n\u001b[29;33H4 2026 +0200\r\n4ce814015c9d83a3d04c0bdf77f2b5463\r\n\u001b[29;33H31990efd Error feedback after edit\r\n\u001b[29;33Hts, edit recovery, file search, a \r\n\u001b[29;33H task list, environment context, a\r\n\u001b[29;33Ha reviewer and an advisor, plan ex\r\n\u001b[29;33Hxecutors and a CI watcher (0.1.9-t\r\n\u001b[29;33Htest.2) (#113) lgiaccar Mon Oct 5 \r\n\u001b[29;33H 11:31:34 2026 +0200\r\n5b0d48ac481babf678aeaa46d4a568014\r\n\u001b[29;33H4a3f4fdd Release 0.1.8: bump exten\r\n\u001b[29;33Hnsion version. (#112) lgiaccar Sun\u001b[?25l\r\n\u001b[29;33Hn Oct 4 21:52:20 2026 +0200       \u001b[30;27H\u001b[?25h\r\n"

const GIT_LOG_LINES = [
	"babd20e54c75e40f1427a1b7d4d1efb3034aaa8e Side questions off the record, and Plan, Agent and Ask in their own colors (0.1.9-test.3) (#114) lgiaccar Mon Oct 5 19:16:04 2026 +0200",
	"4ce814015c9d83a3d04c0bdf77f2b54631990efd Error feedback after edits, edit recovery, file search, a task list, environment context, a reviewer and an advisor, plan executors and a CI watcher (0.1.9-test.2) (#113) lgiaccar Mon Oct 5 11:31:34 2026 +0200",
	"5b0d48ac481babf678aeaa46d4a568014a3f4fdd Release 0.1.8: bump extension version. (#112) lgiaccar Sun Oct 4 21:52:20 2026 +0200",
]

// A colored line wrapped twice, a line exactly as wide as the terminal, and one
// twice as wide.
const MIXED =
	"RUN_DIR=D:/dev0/GPUSurfer/ai_outp\r\n\u001b[29;33Hput/surfer_target_cases/20261006_\r\n\u001b[29;33H_124919\r\nshort\r\n\u001b[38;5;10mabcdefghijabcdefghijabcdefghijabc\u001b[m\r\n\u001b[38;5;10m\u001b[29;33Hcdefghijabcdefghijabcdefghijabcdef\u001b[m\r\n\u001b[38;5;10m\u001b[29;33Hfghijabcdefghijabcdefghij\u001b[m\r\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\u001b[30;1H\nyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\r\n\u001b[29;33Hyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy\u001b[30;1H\nend\r\n"

const MIXED_LINES = [
	"RUN_DIR=D:/dev0/GPUSurfer/ai_output/surfer_target_cases/20261006_124919",
	"short",
	"abcdefghij".repeat(9),
	"x".repeat(33),
	"y".repeat(66),
	"end",
]

function lines(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line.length > 0)
}

function run(chunks: string[]): string {
	const joiner = new ConptyWrapJoiner()
	return chunks.map((chunk) => joiner.push(chunk)).join("") + joiner.flush()
}

describe("ConptyWrapJoiner", () => {
	it("joins the rows ConPTY splits a long line into", () => {
		expect(lines(run([GIT_LOG]))).toEqual(GIT_LOG_LINES)
		expect(lines(run([MIXED]))).toEqual(MIXED_LINES)
	})

	it("reports the terminal width once a wrapped line shows it", () => {
		const joiner = new ConptyWrapJoiner()
		joiner.push("short\r\nlines\r\n")
		expect(joiner.columns).toBeUndefined()
		joiner.push(GIT_LOG)
		expect(joiner.columns).toBe(33)
	})

	it("joins a continuation split across chunks at any point", () => {
		const join = "1\r\n\u001b[29;33H1"
		const text = `RUN_DIR=D:/dev0/GPUSurfer/ai_output/surfer_target_cases/2026100${join}24919\r\nnext\r\n`
		const start = text.indexOf(join)
		for (let cut = start; cut <= start + join.length; cut++) {
			expect(lines(run([text.slice(0, cut), text.slice(cut)]))).toEqual([
				"RUN_DIR=D:/dev0/GPUSurfer/ai_output/surfer_target_cases/2026100124919",
				"next",
			])
		}
	})

	it("keeps real line breaks", () => {
		// A cursor move after a line break without the repeated character, or
		// to the first column, is not a continuation.
		expect(lines(run(["first line\r\n\u001b[5;10Hsecond\r\n"]))).toEqual(["first line", "second"])
		expect(lines(run(["first line\r\n\u001b[29;33Hsecond\r\n"]))).toEqual(["first line", "second"])
		expect(lines(run(["first line\r\n\u001b[29;1Hesecond\r\n"]))).toEqual(["first line", "esecond"])
		expect(lines(run(["a\r\nb\r\nc"]))).toEqual(["a", "b", "c"])
	})

	it("holds back a trailing line break until the next chunk or flush", () => {
		const joiner = new ConptyWrapJoiner()
		expect(joiner.push("done\r\n")).toBe("done")
		expect(joiner.push("more\r")).toBe("\r\nmore")
		expect(joiner.flush()).toBe("\r")
	})
})
