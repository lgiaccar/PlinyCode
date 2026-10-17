/**
 * The diagnostics bundle (docs/diagnostics-bundle.md): one folder with what a
 * maintainer needs to look into a bad run, written by "PlinyCode: Export
 * Diagnostics Bundle". This module collects and writes; it knows nothing of
 * VS Code, so the host side (`hosts/vscode/diagnostics-bundle.ts`) hands it
 * the values it reads from the editor and the controller.
 *
 * Every optional source may be missing: a trace folder that does not exist
 * yet, a conversation that has not sent a request, an MCP settings file that
 * was never created. Each is listed in the bundle's README with the reason,
 * and the bundle is still written.
 */

import fs from "fs/promises"
import path from "path"
import { redactText, redactValue } from "./redact"

/** Lines kept from the end of each router JSONL log. */
const ROUTER_LOG_TAIL_LINES = 500
/** Largest trace copy; a longer file is cut to its last whole lines within this many bytes. */
const TRACE_MAX_BYTES = 20 * 1024 * 1024

const ROUTER_RULES_FILE = /^pliny-(free|balance)-auto(\.[A-Za-z0-9_-]+)?\.md$/
const ROUTER_LOG_FILES = ["pliny-free-auto-calls.jsonl", "pliny-free-auto-runs.jsonl"]
const LOG_FILES = ["plinycode.log", "plinycode.1.log"]

interface DiagnosticsBundleDeps {
	/** PlinyCode's data folder; the bundle is written under `<dataDir>/diagnostics/`. */
	dataDir: string
	now?: () => Date
	/** Extension, editor, OS and runtime versions. Nothing that names the machine or the user. */
	versions: Record<string, unknown>
	/** Effective `plinycode.*` editor settings, keyed by the setting id. */
	editorSettings: Record<string, unknown>
	/** StateManager's global state and settings. */
	globalState: Record<string, unknown>
	/** StateManager's workspace state (rules toggles). */
	workspaceState?: Record<string, unknown>
	/** State keys that are never written, whatever their name: the secret keys and the task history. */
	excludedStateKeys?: readonly string[]
	/** The displayed conversation, when there is one. */
	sessionId?: string
	/** The displayed conversation's last model request as JSON (`formatLastModelRequest`), if captured. */
	lastModelRequest?: string
	/** Renders the displayed conversation as markdown; undefined when it cannot be rendered. */
	renderConversation?: () => Promise<string | undefined>
	/** The MCP settings file McpHub reads. */
	mcpSettingsPath?: string
	/** The CI Board's store. */
	ciBoardPath?: string
	/** Where session traces live; defaults to `<dataDir>/traces`. */
	tracesDir?: string
	/** Where the log files live; defaults to `<dataDir>/logs`. */
	logsDir?: string
	/** Largest trace copy in bytes; defaults to 20 MB. */
	traceMaxBytes?: number
}

interface MissingItem {
	item: string
	reason: string
}

interface DiagnosticsBundleResult {
	/** The bundle folder. */
	dir: string
	/** Files written, relative to `dir`, in README order. */
	included: string[]
	/** What could not be included, and why. */
	missing: MissingItem[]
}

/** `yyyyMMdd-HHmmss` in local time, the bundle folder's name. */
function bundleFolderName(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0")
	return (
		`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
		`-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
	)
}

/** Writes the bundle and returns where it went and what it holds. */
export async function writeDiagnosticsBundle(deps: DiagnosticsBundleDeps): Promise<DiagnosticsBundleResult> {
	const now = deps.now ? deps.now() : new Date()
	const dir = path.join(deps.dataDir, "diagnostics", bundleFolderName(now))
	await fs.mkdir(dir, { recursive: true })

	const included: { file: string; what: string }[] = []
	const missing: MissingItem[] = []
	const write = async (relative: string, content: string, what: string) => {
		const target = path.join(dir, relative)
		await fs.mkdir(path.dirname(target), { recursive: true })
		await fs.writeFile(target, content, "utf8")
		included.push({ file: relative, what })
	}

	await write("versions.json", `${JSON.stringify(deps.versions, null, 2)}\n`, "extension, editor, OS and runtime versions")

	await write(
		"settings.json",
		`${JSON.stringify(collectSettings(deps), null, 2)}\n`,
		"PlinyCode settings and state, secrets removed",
	)

	if (deps.lastModelRequest) {
		await write(
			"last-model-request.txt",
			redactText(deps.lastModelRequest),
			"the last request the displayed conversation sent to its model",
		)
	} else {
		await write("last-model-request.txt", "not captured\n", "the last model request (none captured)")
		missing.push({
			item: "last-model-request.txt",
			reason: deps.sessionId
				? "the displayed conversation has not sent a model request since the window opened; the file says so"
				: "no conversation is displayed; the file says so",
		})
	}

	await collectRouterFiles(deps.dataDir, dir, included, missing)

	await collectTrace(deps, dir, included, missing)

	await collectLogs(deps.logsDir ?? path.join(deps.dataDir, "logs"), dir, included, missing)

	await collectRedactedJson(
		deps.mcpSettingsPath,
		"mcp-settings.json",
		"MCP server settings, environments and headers redacted",
		dir,
		included,
		missing,
	)

	await collectRedactedJson(
		deps.ciBoardPath,
		"ci-board.json",
		"the CI Board's targets, statuses and triage",
		dir,
		included,
		missing,
	)

	await collectConversation(deps, dir, included, missing)

	const readme = renderReadme({ now, deps, included, missing })
	await fs.writeFile(path.join(dir, "README.md"), readme, "utf8")

	return { dir, included: ["README.md", ...included.map((entry) => entry.file)], missing }
}

function collectSettings(deps: DiagnosticsBundleDeps): Record<string, unknown> {
	const excluded = new Set(deps.excludedStateKeys ?? [])
	const keep = (entries: Record<string, unknown>) =>
		Object.fromEntries(Object.entries(entries).filter(([key]) => !excluded.has(key)))
	return {
		note: "Effective plinycode.* editor settings and PlinyCode's stored state. Secret keys and the task history are left out; values under keys that name a secret, and values that look like credentials, read [REDACTED].",
		editor: redactValue(keep(deps.editorSettings)),
		global: redactValue(keep(deps.globalState)),
		...(deps.workspaceState ? { workspace: redactValue(keep(deps.workspaceState)) } : {}),
	}
}

async function collectRouterFiles(
	dataDir: string,
	dir: string,
	included: { file: string; what: string }[],
	missing: MissingItem[],
): Promise<void> {
	let names: string[] = []
	try {
		names = await fs.readdir(dataDir)
	} catch (error) {
		missing.push({ item: "router/", reason: `the data folder could not be listed: ${describe(error)}` })
		return
	}
	const rules = names.filter((name) => ROUTER_RULES_FILE.test(name)).sort()
	if (rules.length === 0) {
		missing.push({ item: "router/*.md", reason: "no routing rules file has been written yet" })
	}
	for (const name of rules) {
		try {
			await copyInto(path.join(dataDir, name), path.join(dir, "router", name))
			included.push({ file: `router/${name}`, what: "routing rules" })
		} catch (error) {
			missing.push({ item: `router/${name}`, reason: describe(error) })
		}
	}
	for (const name of ROUTER_LOG_FILES) {
		const source = path.join(dataDir, name)
		if (!names.includes(name)) {
			missing.push({
				item: `router/${name}`,
				reason: "not written yet: it appears once an auto-free or auto-paid-balanced model handles a request",
			})
			continue
		}
		try {
			const tail = await tailLines(source, ROUTER_LOG_TAIL_LINES)
			const target = path.join(dir, "router", name)
			await fs.mkdir(path.dirname(target), { recursive: true })
			await fs.writeFile(target, tail.text, "utf8")
			included.push({
				file: `router/${name}`,
				what: tail.truncated ? `the last ${ROUTER_LOG_TAIL_LINES} lines of the router's log` : "the router's log, whole",
			})
		} catch (error) {
			missing.push({ item: `router/${name}`, reason: describe(error) })
		}
	}
}

async function collectTrace(
	deps: DiagnosticsBundleDeps,
	dir: string,
	included: { file: string; what: string }[],
	missing: MissingItem[],
): Promise<void> {
	if (!deps.sessionId) {
		missing.push({ item: "trace/", reason: "no conversation is displayed" })
		return
	}
	const name = `${deps.sessionId}.jsonl`
	const source = path.join(deps.tracesDir ?? path.join(deps.dataDir, "traces"), name)
	if (!(await exists(source))) {
		missing.push({
			item: `trace/${name}`,
			reason: "no trace file for this conversation (traces are written by builds that have session tracing)",
		})
		return
	}
	try {
		const target = path.join(dir, "trace", name)
		await fs.mkdir(path.dirname(target), { recursive: true })
		const maxBytes = deps.traceMaxBytes ?? TRACE_MAX_BYTES
		const truncated = await copyTail(source, target, maxBytes)
		included.push({
			file: `trace/${name}`,
			what: truncated ? `the conversation's trace, cut to its last ${formatBytes(maxBytes)}` : "the conversation's trace",
		})
	} catch (error) {
		missing.push({ item: `trace/${name}`, reason: describe(error) })
	}
}

async function collectLogs(
	logsDir: string,
	dir: string,
	included: { file: string; what: string }[],
	missing: MissingItem[],
): Promise<void> {
	const [current, rotated] = LOG_FILES
	if (!(await exists(path.join(logsDir, current)))) {
		missing.push({
			item: `logs/${current}`,
			reason: "no log file (the log file is written by builds that have it; this window's lines are in the PlinyCode Output channel)",
		})
		return
	}
	for (const name of LOG_FILES) {
		const source = path.join(logsDir, name)
		if (!(await exists(source))) {
			if (name === rotated) {
				missing.push({ item: `logs/${rotated}`, reason: "the log has not rotated yet" })
			}
			continue
		}
		try {
			await copyInto(source, path.join(dir, "logs", name))
			included.push({
				file: `logs/${name}`,
				what: name === current ? "the current log file" : "the most recent rotated log file",
			})
		} catch (error) {
			missing.push({ item: `logs/${name}`, reason: describe(error) })
		}
	}
}

async function collectRedactedJson(
	source: string | undefined,
	relative: string,
	what: string,
	dir: string,
	included: { file: string; what: string }[],
	missing: MissingItem[],
): Promise<void> {
	if (!source) {
		missing.push({ item: relative, reason: "no path is known for it" })
		return
	}
	if (!(await exists(source))) {
		missing.push({ item: relative, reason: `the file does not exist (${source})` })
		return
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(await fs.readFile(source, "utf8"))
	} catch (error) {
		// Not written raw: an unparseable file cannot be redacted key by key.
		missing.push({
			item: relative,
			reason: `the file could not be read as JSON, so it is left out rather than written unredacted: ${describe(error)}`,
		})
		return
	}
	await fs.writeFile(path.join(dir, relative), `${JSON.stringify(redactValue(parsed), null, 2)}\n`, "utf8")
	included.push({ file: relative, what })
}

async function collectConversation(
	deps: DiagnosticsBundleDeps,
	dir: string,
	included: { file: string; what: string }[],
	missing: MissingItem[],
): Promise<void> {
	if (!deps.sessionId || !deps.renderConversation) {
		missing.push({ item: "conversation.md", reason: "no conversation is displayed" })
		return
	}
	try {
		const markdown = await deps.renderConversation()
		if (!markdown) {
			missing.push({ item: "conversation.md", reason: "the conversation could not be rendered" })
			return
		}
		await fs.writeFile(path.join(dir, "conversation.md"), redactText(markdown), "utf8")
		included.push({ file: "conversation.md", what: "the displayed conversation as markdown" })
	} catch (error) {
		missing.push({ item: "conversation.md", reason: describe(error) })
	}
}

function renderReadme(input: {
	now: Date
	deps: DiagnosticsBundleDeps
	included: { file: string; what: string }[]
	missing: MissingItem[]
}): string {
	const { now, deps, included, missing } = input
	const version = typeof deps.versions.plinycode === "string" ? ` ${deps.versions.plinycode}` : ""
	const lines = [
		"# PlinyCode diagnostics bundle",
		"",
		`Written ${now.toISOString()} by PlinyCode${version}` +
			(deps.sessionId ? ` for conversation \`${deps.sessionId}\`.` : ", with no conversation displayed."),
		"",
		"## Before you share this folder",
		"",
		"Read through every file and remove anything you would not share. Settings, MCP settings and the CI Board",
		"file have had secret-looking keys and values replaced by `[REDACTED]`, and obvious tokens are removed from",
		"the text files, but the conversation, the last model request, the trace and the logs hold whatever the",
		"model and its tools saw: file contents, command output, paths and repository names.",
		"",
		"## Contents",
		"",
		"- `README.md`: this file.",
		...included.map((entry) => `- \`${entry.file}\`: ${entry.what}.`),
		"",
		"## Not available",
		"",
	]
	if (missing.length === 0) {
		lines.push("Everything the bundle can hold was found.")
	} else {
		lines.push(...missing.map((entry) => `- \`${entry.item}\`: ${entry.reason}.`))
	}
	lines.push("", "See `docs/diagnostics-bundle.md` in the PlinyCode repository for what each file means.", "")
	return lines.join("\n")
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

async function exists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

async function copyInto(source: string, target: string): Promise<void> {
	await fs.mkdir(path.dirname(target), { recursive: true })
	await fs.copyFile(source, target)
}

/**
 * The last `count` lines of a text file, read from the end in chunks so a
 * large log is not loaded whole. `truncated` says whether lines were dropped.
 */
async function tailLines(filePath: string, count: number): Promise<{ text: string; truncated: boolean }> {
	const handle = await fs.open(filePath, "r")
	try {
		const { size } = await handle.stat()
		const chunkSize = 64 * 1024
		let position = size
		let buffered = ""
		let newlines = 0
		while (position > 0 && newlines <= count) {
			const length = Math.min(chunkSize, position)
			position -= length
			const buffer = Buffer.alloc(length)
			await handle.read(buffer, 0, length, position)
			buffered = buffer.toString("utf8") + buffered
			newlines = countNewlines(buffered)
		}
		const text = buffered.endsWith("\n") ? buffered.slice(0, -1) : buffered
		const lines = text.length ? text.split("\n") : []
		const truncated = position > 0 || lines.length > count
		const kept = lines.slice(-count)
		return { text: kept.length ? `${kept.join("\n")}\n` : "", truncated }
	} finally {
		await handle.close()
	}
}

function countNewlines(text: string): number {
	let count = 0
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		count++
	}
	return count
}

/**
 * Copies a file, or when it is larger than `maxBytes`, its last `maxBytes`
 * cut at the first line break so the copy starts on a whole line. Returns
 * whether it was cut.
 */
async function copyTail(source: string, target: string, maxBytes: number): Promise<boolean> {
	const { size } = await fs.stat(source)
	if (size <= maxBytes) {
		await fs.copyFile(source, target)
		return false
	}
	const handle = await fs.open(source, "r")
	try {
		const buffer = Buffer.alloc(maxBytes)
		await handle.read(buffer, 0, maxBytes, size - maxBytes)
		const firstBreak = buffer.indexOf(0x0a)
		const whole = firstBreak === -1 ? buffer : buffer.subarray(firstBreak + 1)
		await fs.writeFile(target, whole)
		return true
	} finally {
		await handle.close()
	}
}

function formatBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) {
		return `${Math.round(bytes / 1024 / 1024)} MB`
	}
	return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
