import { strict as assert } from "assert"
import * as fs from "fs/promises"
import { afterEach, beforeEach, describe, it } from "mocha"
import * as os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { createVscodeEditDiagnosticsSource, isReportNewProblemsEnabled } from "@/hosts/vscode/edit-diagnostics"
import { EditProblemsReporter } from "@/sdk/edit-problems"
import { arePathsEqual } from "@/utils/path"

// Runs against the editor's real JSON language server (a built-in extension, so
// it is there with --disable-extensions): the reporter's wait is only as good as
// the diagnostics events the editor actually sends.
describe("Edit diagnostics in the editor", function () {
	this.timeout(90_000)

	// Longer than the shipped timings: the first answer of a language server
	// includes its start-up, and the test is about what is reported, not how fast.
	const timings = { firstEventTimeoutMs: 10_000, quietPeriodMs: 500, maxWaitMs: 15_000 }
	const source = createVscodeEditDiagnosticsSource()
	let dir: string
	let reporter: EditProblemsReporter

	beforeEach(async () => {
		dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "edit-diagnostics-")))
		reporter = new EditProblemsReporter({ source, isEnabled: () => true, timings })
		await vscode.commands.executeCommand("workbench.action.closeAllEditors")
	})

	afterEach(async () => {
		reporter.dispose()
		await vscode.commands.executeCommand("workbench.action.closeAllEditors")
		// The editor can still hold the directory for a moment on Windows; it is a temp directory either way.
		await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {})
	})

	async function writeFile(name: string, content: string): Promise<string> {
		const absolutePath = path.join(dir, name)
		await fs.writeFile(absolutePath, content)
		return absolutePath
	}

	/**
	 * Opens the file in a tab, as an earlier edit leaves it. VS Code starts watching a
	 * file outside the workspace a moment after its tab opens and misses a write made
	 * before that for good, so the test lets the tab sit as a user's would.
	 */
	async function openInTab(absolutePath: string): Promise<void> {
		await vscode.window.showTextDocument(vscode.Uri.file(absolutePath), { preview: false })
		await new Promise((resolve) => setTimeout(resolve, 1_500))
	}

	/** One edit as the edit tools make it: a write to disk, then the report. */
	async function edit(absolutePath: string, content: string): Promise<string> {
		const check = reporter.begin([{ absolutePath, displayPath: path.basename(absolutePath) }])
		assert.ok(check, "expected a check")
		await fs.writeFile(absolutePath, content)
		check.written()
		return check.report()
	}

	it("reports the error an edit introduces in a file that no editor shows, without changing the visible editor", async () => {
		const visible = await writeFile("visible.txt", "the user is reading this\n")
		await vscode.window.showTextDocument(vscode.Uri.file(visible), { preview: false })
		const settings = await writeFile("settings.json", '{\n\t"a": 1\n}\n')
		assert.equal(source.isShown(settings), false)

		const report = await edit(settings, '{\n\t"a": 1,,\n}\n')

		assert.match(report, /^\n\nNew problems reported in this file after the edit \(fix them if your change caused them\):\n/)
		assert.match(report, /\n- line 2: .+/)
		// The background tab the check needed is closed again, and the user's editor was never replaced.
		await pWaitFor(() => !source.isShown(settings), { timeout: 10_000 })
		assert.ok(arePathsEqual(vscode.window.activeTextEditor?.document.uri.fsPath, visible))
	})

	it("reports only the new error of a file that is open in a tab", async () => {
		const settings = await writeFile("settings.json", '{\n\t"a": 1,,\n\t"b": 2\n}\n')
		await openInTab(settings)
		await pWaitFor(() => source.getErrors(settings).length > 0, { timeout: 30_000 })
		const before = source.getErrors(settings)

		// The old error moves down a line and a stray brace adds a new one.
		const report = await edit(settings, '{\n\n\t"a": 1,,\n\t"b": 2\n}\n}\n')

		const after = source.getErrors(settings)
		const document = vscode.workspace.textDocuments.find((d) => arePathsEqual(d.uri.fsPath, settings))
		assert.ok(
			after.length > before.length,
			`the edit should have added an error: ${JSON.stringify({ before, after, version: document?.version, text: document?.getText() })}`,
		)
		const reported = report.split("\n").filter((line) => line.startsWith("- line "))
		assert.equal(reported.length, after.length - before.length)
		for (const problem of before) {
			assert.ok(!report.includes(problem.message), `"${problem.message}" was there before the edit`)
		}
		assert.equal(source.isShown(settings), true)
	})

	it("is turned off by the plinycode.edits.reportNewProblems setting", async () => {
		const configuration = vscode.workspace.getConfiguration("plinycode.edits")
		assert.equal(isReportNewProblemsEnabled(), true)
		await configuration.update("reportNewProblems", false, vscode.ConfigurationTarget.Global)
		try {
			assert.equal(isReportNewProblemsEnabled(), false)
			const gated = new EditProblemsReporter({ source, isEnabled: isReportNewProblemsEnabled, timings })
			assert.equal(gated.begin([{ absolutePath: path.join(dir, "a.json"), displayPath: "a.json" }]), undefined)
		} finally {
			await configuration.update("reportNewProblems", undefined, vscode.ConfigurationTarget.Global)
		}
	})

	it("says nothing about an edit that leaves the file without errors", async () => {
		const settings = await writeFile("settings.json", '{\n\t"a": 1\n}\n')
		await openInTab(settings)

		assert.equal(await edit(settings, '{\n\t"a": 2\n}\n'), "")
	})
})
