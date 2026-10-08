import * as path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type EditDiagnosticsSource, type EditProblem, type EditProblemCheck, EditProblemsReporter } from "./edit-problems"

/** A language server reduced to what the reporter sees of it. */
class FakeDiagnostics implements EditDiagnosticsSource {
	readonly errors = new Map<string, EditProblem[]>()
	readonly shown = new Set<string>()
	/** Document versions of the files the editor has loaded; unloaded by default. */
	readonly versions = new Map<string, number>()
	readonly openedInBackground: string[] = []
	readonly closedAgain: string[] = []
	private readonly listeners = new Set<(absolutePaths: string[]) => void>()
	failReads = false
	failBackgroundOpen = false
	/** Mimics a host that drops a file's diagnostics once its background tab closes. */
	forgetOnClose = false

	getErrors(absolutePath: string): EditProblem[] {
		if (this.failReads) {
			throw new Error("diagnostics unavailable")
		}
		return this.errors.get(absolutePath) ?? []
	}

	documentVersion(absolutePath: string): number | undefined {
		return this.versions.get(absolutePath)
	}

	onDidChangeDiagnostics(listener: (absolutePaths: string[]) => void): { dispose(): void } {
		this.listeners.add(listener)
		return { dispose: () => this.listeners.delete(listener) }
	}

	isShown(absolutePath: string): boolean {
		return this.shown.has(absolutePath)
	}

	async showInBackground(absolutePath: string): Promise<() => Promise<void>> {
		if (this.failBackgroundOpen) {
			throw new Error("cannot open")
		}
		this.openedInBackground.push(absolutePath)
		this.shown.add(absolutePath)
		return async () => {
			this.shown.delete(absolutePath)
			this.closedAgain.push(absolutePath)
			if (this.forgetOnClose) {
				this.errors.delete(absolutePath)
			}
		}
	}

	/** Publishes a file's errors, as a language server does after analysing it. */
	publish(absolutePath: string, errors: EditProblem[]): void {
		this.errors.set(absolutePath, errors)
		for (const listener of this.listeners) {
			listener([absolutePath])
		}
	}

	get listenerCount(): number {
		return this.listeners.size
	}
}

const TIMINGS = { firstEventTimeoutMs: 1_500, quietPeriodMs: 300, maxWaitMs: 3_000, lateAnswerWindowMs: 60_000 }
const HEADER = "\n\nNew problems reported in this file after the edit (fix them if your change caused them):"

function file(name: string) {
	return { absolutePath: path.resolve("/repo", name), displayPath: name }
}

function tsError(line: number, message: string, code = "2304"): EditProblem {
	return { line, message, source: "ts", code }
}

describe("EditProblemsReporter", () => {
	let diagnostics: FakeDiagnostics
	let enabled: boolean
	let reporter: EditProblemsReporter
	const a = file("src/a.ts")
	const b = file("src/b.ts")

	beforeEach(() => {
		vi.useFakeTimers()
		diagnostics = new FakeDiagnostics()
		enabled = true
		reporter = new EditProblemsReporter({ source: diagnostics, isEnabled: () => enabled, timings: TIMINGS })
		// Most tests edit files that have a tab, as files do once PlinyCode has edited them.
		diagnostics.shown.add(a.absolutePath)
		diagnostics.shown.add(b.absolutePath)
	})

	afterEach(() => {
		reporter.dispose()
		vi.useRealTimers()
	})

	function begin(...files: ReturnType<typeof file>[]): EditProblemCheck {
		const check = reporter.begin(files)
		if (!check) {
			throw new Error("expected a check")
		}
		return check
	}

	/** Runs a check whose language server publishes `errors` `afterMs` after the write. */
	async function editThenPublish(target: ReturnType<typeof file>, errors: EditProblem[], afterMs = 500): Promise<string> {
		const check = begin(target)
		check.written()
		const report = check.report()
		await vi.advanceTimersByTimeAsync(afterMs)
		diagnostics.publish(target.absolutePath, errors)
		await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
		return report
	}

	/** Runs a check whose language server stays silent. */
	async function editInSilence(target: ReturnType<typeof file>): Promise<string> {
		const check = begin(target)
		check.written()
		const report = check.report()
		await vi.advanceTimersByTimeAsync(TIMINGS.maxWaitMs)
		return report
	}

	it("reports an error the edit introduced, with its line, source and code", async () => {
		const report = await editThenPublish(a, [tsError(12, "Cannot find name 'foo'.")])

		expect(report).toBe(`${HEADER}\n- line 12: Cannot find name 'foo'. (ts 2304)`)
	})

	it("leaves out the source and code a diagnostic does not have", async () => {
		const report = await editThenPublish(a, [
			{ line: 3, message: "Unexpected token" },
			{ line: 5, message: "Missing semicolon", source: "eslint" },
		])

		expect(report).toBe(`${HEADER}\n- line 3: Unexpected token\n- line 5: Missing semicolon (eslint)`)
	})

	it("does not report an error that was there before, even when the edit moved it", async () => {
		diagnostics.errors.set(a.absolutePath, [tsError(4, "Cannot find name 'old'.")])

		const report = await editThenPublish(a, [tsError(9, "Cannot find name 'old'."), tsError(2, "Cannot find name 'foo'.")])

		expect(report).toBe(`${HEADER}\n- line 2: Cannot find name 'foo'. (ts 2304)`)
	})

	it("reports a second copy of an error that was there once", async () => {
		diagnostics.errors.set(a.absolutePath, [tsError(4, "Cannot find name 'x'.")])

		const report = await editThenPublish(a, [tsError(4, "Cannot find name 'x'."), tsError(8, "Cannot find name 'x'.")])

		expect(report).toBe(`${HEADER}\n- line 8: Cannot find name 'x'. (ts 2304)`)
	})

	it("says nothing when the edit removes errors", async () => {
		diagnostics.errors.set(a.absolutePath, [tsError(4, "Cannot find name 'old'."), tsError(6, "Cannot find name 'older'.")])

		expect(await editThenPublish(a, [tsError(4, "Cannot find name 'old'.")])).toBe("")
		expect(await editThenPublish(a, [])).toBe("")
	})

	it("lists at most ten problems and counts the rest", async () => {
		const errors = Array.from({ length: 13 }, (_, index) => tsError(index + 1, `Cannot find name 'n${index}'.`))

		const report = await editThenPublish(a, errors)

		const lines = report.trim().split("\n")
		expect(lines).toHaveLength(12)
		expect(lines[10]).toBe("- line 10: Cannot find name 'n9'. (ts 2304)")
		expect(lines[11]).toBe("and 3 more")
	})

	it("puts a multi-line message on one line and clips a long one", async () => {
		const report = await editThenPublish(a, [
			tsError(1, "Type 'string' is not assignable to type 'number'.\n  The types are incompatible.", "2322"),
			tsError(2, "x".repeat(500)),
		])

		const lines = report.trim().split("\n")
		expect(lines[1]).toBe("- line 1: Type 'string' is not assignable to type 'number'. The types are incompatible. (ts 2322)")
		expect(lines[2]).toBe(`- line 2: ${"x".repeat(299)}… (ts 2304)`)
	})

	it("groups the problems of a multi-file edit by file and skips the files without any", async () => {
		const c = file("src/c.ts")
		diagnostics.shown.add(c.absolutePath)
		const check = begin(a, b, c)
		check.written()
		const report = check.report()
		diagnostics.publish(a.absolutePath, [tsError(3, "Cannot find name 'foo'.")])
		diagnostics.publish(b.absolutePath, [])
		diagnostics.publish(c.absolutePath, [tsError(7, "Cannot find name 'bar'."), tsError(1, "Cannot find name 'baz'.")])
		await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)

		expect(await report).toBe(
			[
				"\n\nNew problems reported after the edit (fix them if your change caused them):",
				"src/a.ts",
				"- line 3: Cannot find name 'foo'. (ts 2304)",
				"src/c.ts",
				"- line 1: Cannot find name 'baz'. (ts 2304)",
				"- line 7: Cannot find name 'bar'. (ts 2304)",
			].join("\n"),
		)
	})

	it("compares a moved file with the errors it had at its old path", async () => {
		const moved = { ...file("src/new-name.ts"), previousPath: a.absolutePath }
		diagnostics.shown.add(moved.absolutePath)
		diagnostics.errors.set(a.absolutePath, [tsError(4, "Cannot find name 'old'.")])

		const report = await editThenPublish(moved, [
			tsError(4, "Cannot find name 'old'."),
			tsError(5, "Cannot find name 'foo'."),
		])

		expect(report).toBe(`${HEADER}\n- line 5: Cannot find name 'foo'. (ts 2304)`)
	})

	describe("waiting", () => {
		it("reads the diagnostics once they have been quiet, not at the first event", async () => {
			const check = begin(a)
			check.written()
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			await vi.advanceTimersByTimeAsync(400)
			diagnostics.publish(a.absolutePath, [tsError(1, "Unterminated string literal.", "1002")])
			await vi.advanceTimersByTimeAsync(200)
			// The server's second pass replaces the first before the quiet period is over.
			diagnostics.publish(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs - 1)
			expect(report).toBeUndefined()

			await vi.advanceTimersByTimeAsync(1)
			expect(report).toBe(`${HEADER}\n- line 2: Cannot find name 'foo'. (ts 2304)`)
		})

		it("gives up when no diagnostics event arrives, and returns nothing", async () => {
			const check = begin(a)
			check.written()
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			await vi.advanceTimersByTimeAsync(TIMINGS.firstEventTimeoutMs - 1)
			expect(report).toBeUndefined()
			await vi.advanceTimersByTimeAsync(1)
			expect(report).toBe("")
		})

		it("stops at the cap when the diagnostics never go quiet", async () => {
			const check = begin(a)
			check.written()
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			for (let elapsed = 0; elapsed < TIMINGS.maxWaitMs - 200; elapsed += 200) {
				await vi.advanceTimersByTimeAsync(200)
				diagnostics.publish(a.absolutePath, [tsError(1, `Cannot find name 'n${elapsed}'.`)])
			}
			expect(report).toBeUndefined()
			await vi.advanceTimersByTimeAsync(200)

			expect(report).toBe(`${HEADER}\n- line 1: Cannot find name 'n2600'. (ts 2304)`)
		})

		it("counts the time since the write for a file that already had a tab", async () => {
			const check = begin(a)
			check.written()
			// The caller lingers on its preview while the language server answers.
			await vi.advanceTimersByTimeAsync(500)
			diagnostics.publish(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(1_000)

			// Nothing left to wait for: the report is ready without any timer running.
			expect(await check.report()).toBe(`${HEADER}\n- line 2: Cannot find name 'foo'. (ts 2304)`)

			const silent = begin(b)
			silent.written()
			await vi.advanceTimersByTimeAsync(TIMINGS.firstEventTimeoutMs)
			expect(await silent.report()).toBe("")
		})

		it("ignores the old diagnostics re-published before the editor reloads the written file", async () => {
			const stale = [tsError(4, "Cannot find name 'old'.")]
			diagnostics.errors.set(a.absolutePath, stale)
			diagnostics.versions.set(a.absolutePath, 1)
			const check = begin(a)
			check.written()
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			await vi.advanceTimersByTimeAsync(40)
			diagnostics.publish(a.absolutePath, stale)
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			// Not settled by the stale event: still waiting for the reloaded file's answer.
			expect(report).toBeUndefined()

			diagnostics.versions.set(a.absolutePath, 2)
			await vi.advanceTimersByTimeAsync(200)
			diagnostics.publish(a.absolutePath, [tsError(5, "Cannot find name 'old'."), tsError(6, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			expect(report).toBe(`${HEADER}\n- line 6: Cannot find name 'foo'. (ts 2304)`)
		})

		it("ignores events from before the write", async () => {
			const check = begin(a)
			diagnostics.publish(a.absolutePath, [])
			check.written()
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			expect(report).toBeUndefined()
			diagnostics.publish(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			expect(report).toContain("Cannot find name 'foo'.")
		})

		it("returns at once, with nothing, when the tool call is aborted", async () => {
			const controller = new AbortController()
			const check = begin(a)
			check.written()
			const report = check.report(controller.signal)
			diagnostics.publish(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])

			controller.abort()

			expect(await report).toBe("")
			expect(await begin(a).report(controller.signal)).toBe("")
		})

		it("reports nothing for an edit that never wrote", async () => {
			diagnostics.publish(a.absolutePath, [])
			const check = begin(a)
			diagnostics.errors.set(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])

			expect(await check.report()).toBe("")
		})
	})

	describe("files without a tab", () => {
		const hidden = file("src/hidden.ts")

		it("shows the file in the background while it waits and closes it again", async () => {
			const check = begin(hidden)
			check.written()
			const report = check.report()
			await vi.advanceTimersByTimeAsync(0)
			expect(diagnostics.openedInBackground).toEqual([hidden.absolutePath])
			expect(diagnostics.closedAgain).toEqual([])

			diagnostics.publish(hidden.absolutePath, [tsError(2, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)

			expect(await report).toBe(`${HEADER}\n- line 2: Cannot find name 'foo'. (ts 2304)`)
			expect(diagnostics.closedAgain).toEqual([hidden.absolutePath])
		})

		it("does not open a file the caller has shown since the write", async () => {
			const check = begin(hidden)
			check.written()
			diagnostics.shown.add(hidden.absolutePath)
			const report = check.report()
			await vi.advanceTimersByTimeAsync(TIMINGS.firstEventTimeoutMs)

			expect(await report).toBe("")
			expect(diagnostics.openedInBackground).toEqual([])
		})

		it("gives the language server its time from when the file is shown, not from the write", async () => {
			const check = begin(hidden)
			check.written()
			await vi.advanceTimersByTimeAsync(2_000)
			let report: string | undefined
			void check.report().then((text) => {
				report = text
			})

			await vi.advanceTimersByTimeAsync(TIMINGS.firstEventTimeoutMs - 1)
			expect(report).toBeUndefined()
			await vi.advanceTimersByTimeAsync(1)
			expect(report).toBe("")
		})

		it("keeps the errors it saw as the baseline once the host has stopped analysing the closed file", async () => {
			diagnostics.forgetOnClose = true
			const errors = [tsError(2, "Cannot find name 'foo'.")]
			const first = begin(hidden)
			first.written()
			const firstReport = first.report()
			await vi.advanceTimersByTimeAsync(0)
			diagnostics.publish(hidden.absolutePath, errors)
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			expect(await firstReport).toContain("Cannot find name 'foo'.")
			expect(diagnostics.getErrors(hidden.absolutePath)).toEqual([])

			// The next edit leaves the error where it is: it is not new a second time.
			const second = begin(hidden)
			second.written()
			const secondReport = second.report()
			await vi.advanceTimersByTimeAsync(0)
			diagnostics.publish(hidden.absolutePath, errors)
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)
			expect(await secondReport).toBe("")
		})

		it("reports nothing, without waiting, when the file cannot be shown", async () => {
			diagnostics.failBackgroundOpen = true
			const check = begin(hidden)
			check.written()

			expect(await check.report()).toBe("")
		})
	})

	describe("file types that produce no diagnostics", () => {
		const notes = file("notes.txt")
		const other = file("other.txt")

		it("stops waiting, and stops showing the file, after two silent waits", async () => {
			expect(await editInSilence(notes)).toBe("")
			expect(await editInSilence(other)).toBe("")
			expect(diagnostics.openedInBackground).toHaveLength(2)

			const check = begin(notes)
			check.written()
			// No timer has to run for the third edit.
			expect(await check.report()).toBe("")
			expect(diagnostics.openedInBackground).toHaveLength(2)
		})

		it("waits again once the file type turns out to have diagnostics after all", async () => {
			await editInSilence(notes)
			await editInSilence(notes)
			diagnostics.publish(other.absolutePath, [])

			const report = await editThenPublish(notes, [{ line: 1, message: "Unknown word", source: "spell" }])

			expect(report).toBe(`${HEADER}\n- line 1: Unknown word (spell)`)
		})

		it("keeps waiting for a file type that has ever produced a diagnostics event", async () => {
			await editThenPublish(a, [])
			// A language server that finds nothing to change publishes nothing.
			await editInSilence(a)
			await editInSilence(a)
			await editInSilence(b)

			expect(await editThenPublish(a, [tsError(2, "Cannot find name 'foo'.")], 1_000)).toContain("Cannot find name 'foo'.")
		})

		it("counts a multi-file edit as one silent wait", async () => {
			const check = begin(notes, other)
			check.written()
			const report = check.report()
			await vi.advanceTimersByTimeAsync(TIMINGS.maxWaitMs)
			await report

			// One more silent wait is still due before the type is given up on.
			const second = begin(notes)
			second.written()
			let secondReport: string | undefined
			void second.report().then((text) => {
				secondReport = text
			})
			await vi.advanceTimersByTimeAsync(TIMINGS.firstEventTimeoutMs - 1)
			expect(secondReport).toBeUndefined()
		})
	})

	describe("a language server that answers late", () => {
		it("reports the errors with the next edit, whichever file it touches", async () => {
			expect(await editInSilence(a)).toBe("")
			diagnostics.publish(a.absolutePath, [tsError(12, "Cannot find name 'foo'.")])

			const report = await editThenPublish(b, [tsError(3, "Cannot find name 'bar'.")])

			expect(report).toBe(
				[
					`${HEADER}`,
					"- line 3: Cannot find name 'bar'. (ts 2304)",
					"",
					"New problems reported in files you edited earlier (fix them if your changes caused them):",
					"src/a.ts",
					"- line 12: Cannot find name 'foo'. (ts 2304)",
				].join("\n"),
			)
			// Told once: the following edit has nothing left to add.
			expect(await editThenPublish(b, [tsError(3, "Cannot find name 'bar'.")])).toBe("")
		})

		it("reports them as new when the next edit is to the same file", async () => {
			expect(await editInSilence(a)).toBe("")
			diagnostics.publish(a.absolutePath, [tsError(12, "Cannot find name 'foo'.")])

			const report = await editThenPublish(a, [tsError(14, "Cannot find name 'foo'.")])

			expect(report).toBe(`${HEADER}\n- line 14: Cannot find name 'foo'. (ts 2304)`)
			expect(await editThenPublish(a, [tsError(14, "Cannot find name 'foo'.")])).toBe("")
		})

		it("leaves out errors that were there before the earlier edit", async () => {
			diagnostics.errors.set(a.absolutePath, [tsError(4, "Cannot find name 'old'.")])
			await editInSilence(a)
			diagnostics.publish(a.absolutePath, [tsError(4, "Cannot find name 'old'.")])

			expect(await editThenPublish(b, [])).toBe("")
		})

		it("forgets them for a conversation that replaced the one that made the edit", async () => {
			await editInSilence(a)
			diagnostics.publish(a.absolutePath, [tsError(12, "Cannot find name 'foo'.")])

			reporter.forget()

			expect(await editThenPublish(b, [])).toBe("")
			// The error is now part of the file's baseline, not new to an edit of it.
			expect(await editThenPublish(a, [tsError(12, "Cannot find name 'foo'.")])).toBe("")
		})

		it("does not put an error down to an edit made long before it appeared", async () => {
			await editInSilence(a)
			await vi.advanceTimersByTimeAsync(TIMINGS.lateAnswerWindowMs)
			diagnostics.publish(a.absolutePath, [tsError(12, "Cannot find name 'foo'.")])

			expect(await editThenPublish(b, [])).toBe("")
		})
	})

	describe("when it cannot work", () => {
		it("does nothing while the setting is off", async () => {
			enabled = false
			const getErrors = vi.spyOn(diagnostics, "getErrors")

			expect(reporter.begin([a])).toBeUndefined()
			expect(getErrors).not.toHaveBeenCalled()
			expect(diagnostics.listenerCount).toBe(0)
		})

		it("gives no check when the diagnostics cannot be read before the edit", () => {
			diagnostics.failReads = true

			expect(reporter.begin([a])).toBeUndefined()
		})

		it("returns nothing when the diagnostics cannot be read after the edit", async () => {
			const check = begin(a)
			check.written()
			const report = check.report()
			diagnostics.failReads = true
			diagnostics.publish(a.absolutePath, [tsError(2, "Cannot find name 'foo'.")])
			await vi.advanceTimersByTimeAsync(TIMINGS.quietPeriodMs)

			expect(await report).toBe("")
		})

		it("stops listening when disposed", () => {
			begin(a)
			expect(diagnostics.listenerCount).toBe(1)

			reporter.dispose()

			expect(diagnostics.listenerCount).toBe(0)
		})
	})
})
