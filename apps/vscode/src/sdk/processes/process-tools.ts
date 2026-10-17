/**
 * `process_list`, `process_output` and `process_kill`: the model's handle on
 * the commands in the ProcessRegistry (process-registry.ts).
 *
 * Before these, a command handed over to the terminal after five minutes left
 * the model a log path and nothing else: no way to ask whether it was still
 * running, and no way to stop it short of guessing a PID for taskkill. Output
 * always comes from the log file, never from the terminal buffer, so it reads
 * the same for a terminal command and a child process, and it survives a
 * window reload.
 *
 * A model sees only the processes of its own conversation; sub-agents share
 * the root's, since they run under the root's session id.
 */

import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import * as fs from "fs"
import { stripAnsi } from "@/hosts/vscode/terminal/ansiUtils"
import type { BackgroundProcess, ProcessRegistry } from "./process-registry"

const DEFAULT_TAIL_LINES = 100
const MAX_TAIL_LINES = 400
const MAX_OUTPUT_BYTES = 32 * 1024
/** How far back from the end of the log to read; enough for MAX_TAIL_LINES of ordinary output. */
const READ_WINDOW_BYTES = 256 * 1024
const MAX_COMMAND_CHARS = 80

/** The conversation a tool call belongs to: the root session id, which sub-agents inherit. */
export function processConversationId(context: Pick<AgentToolContext, "sessionId" | "conversationId">): string {
	return context.sessionId?.trim() || context.conversationId?.trim() || ""
}

function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	const hours = Math.floor(totalSeconds / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	if (hours > 0) {
		return `${hours}h${String(minutes).padStart(2, "0")}m`
	}
	if (minutes > 0) {
		return `${minutes}m${String(seconds).padStart(2, "0")}s`
	}
	return `${seconds}s`
}

function oneLine(command: string, max: number): string {
	const flat = command.replace(/\s*\r?\n\s*/g, " ; ").trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function statusLabel(process: BackgroundProcess): string {
	if (process.status === "exited" && process.exitCode !== undefined) {
		return `exited(${process.exitCode})`
	}
	return process.status
}

function elapsedOf(process: BackgroundProcess, now: number): string {
	return formatElapsed((process.endedAt ?? now) - process.startedAt)
}

/** One sentence on where a process stands, for process_output and process_kill. */
function describeState(process: BackgroundProcess, now: number): string {
	const elapsed = elapsedOf(process, now)
	switch (process.status) {
		case "running":
			return `${process.id} has been running for ${elapsed}`
		case "exited":
			return process.exitCode !== undefined
				? `${process.id} exited with code ${process.exitCode} after ${elapsed}`
				: `${process.id} ended after ${elapsed}`
		case "killed":
			return `${process.id} was stopped after ${elapsed}`
		case "lost":
			return `${process.id} can no longer be observed (after ${elapsed}); it may still be running in its terminal`
	}
}

interface LogTail {
	lines: string[]
	/** Bytes in the file. */
	size: number
	cutToBytes: boolean
}

/** The last `count` lines of a log file, at most MAX_OUTPUT_BYTES of them. Undefined when the file is gone. */
async function readLogTail(logPath: string, count: number): Promise<LogTail | undefined> {
	let handle: fs.promises.FileHandle
	try {
		handle = await fs.promises.open(logPath, "r")
	} catch {
		return undefined
	}
	try {
		const { size } = await handle.stat()
		const start = Math.max(0, size - READ_WINDOW_BYTES)
		const buffer = Buffer.alloc(size - start)
		await handle.read(buffer, 0, buffer.length, start)
		let text = stripAnsi(buffer.toString("utf8"))
		if (start > 0) {
			// The window began mid-line: drop the fragment.
			text = text.slice(text.indexOf("\n") + 1)
		}
		const all = text.split(/\r?\n/)
		if (all.length > 0 && all[all.length - 1] === "") {
			all.pop()
		}
		const lines = all.slice(-count)
		let bytes = 0
		let first = lines.length
		while (first > 0) {
			const lineBytes = Buffer.byteLength(lines[first - 1]) + 1
			if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
				break
			}
			bytes += lineBytes
			first--
		}
		return { lines: lines.slice(first), size, cutToBytes: first > 0 }
	} finally {
		await handle.close()
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`
	}
	if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`
	}
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function clampTail(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
	if (!Number.isFinite(parsed) || parsed < 1) {
		return DEFAULT_TAIL_LINES
	}
	return Math.min(Math.floor(parsed), MAX_TAIL_LINES)
}

interface ProcessToolsOptions {
	registry: ProcessRegistry
	now?: () => number
}

export function createProcessTools(options: ProcessToolsOptions): AgentTool[] {
	const { registry } = options
	const now = options.now ?? (() => Date.now())

	/** The process with this id, if it belongs to the caller's conversation. */
	function find(rawId: unknown, context: AgentToolContext): BackgroundProcess {
		const id = String(rawId ?? "").trim()
		if (!id) {
			throw new Error("Give the process `id` (p1, p2, …) as process_list shows it.")
		}
		const process = registry.get(id)
		if (!process || process.conversationId !== processConversationId(context)) {
			throw new Error(`No background process ${id} in this conversation. process_list shows the ones there are.`)
		}
		return process
	}

	const processList: AgentTool = {
		name: "process_list",
		description:
			"List this conversation's background processes: commands started with run_commands `background: true`, and " +
			"commands handed over to the terminal while still running. One line each: id, status, elapsed time, command, log file.",
		inputSchema: { type: "object", properties: {} },
		executionMode: "parallel",
		retryable: false,
		async execute(_input: unknown, context: AgentToolContext): Promise<string> {
			const processes = registry.list(processConversationId(context))
			if (processes.length === 0) {
				return "No background processes in this conversation."
			}
			const time = now()
			return [
				"id  status  elapsed  command  log",
				...processes.map(
					(process) =>
						`${process.id}  ${statusLabel(process)}  ${elapsedOf(process, time)}  ${oneLine(process.command, MAX_COMMAND_CHARS)}  ${process.logPath}`,
				),
			].join("\n")
		},
	}

	const processOutput: AgentTool = {
		name: "process_output",
		description:
			`Read the end of a background process's log (default ${DEFAULT_TAIL_LINES} lines, at most ${MAX_TAIL_LINES}) and ` +
			"whether it is still running. Use it to follow a server, watcher or long build; call wait between checks.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Process id from process_list or run_commands, e.g. p1." },
				tail_lines: { type: "number", description: `Lines from the end of the log (default ${DEFAULT_TAIL_LINES}).` },
			},
			required: ["id"],
		},
		executionMode: "parallel",
		retryable: false,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as { id?: unknown; tail_lines?: unknown }
			const process = find(input.id, context)
			const count = clampTail(input.tail_lines)
			const header = `${describeState(process, now())}: ${oneLine(process.command, 200)}`
			const tail = await readLogTail(process.logPath, count)
			if (!tail) {
				return `${header}\nThe log file ${process.logPath} no longer exists.`
			}
			const where = `Log: ${process.logPath} (${formatSize(tail.size)})`
			if (tail.lines.length === 0) {
				return `${header}\n${where}\nThe log is empty so far.`
			}
			const label = tail.cutToBytes
				? `Last ${tail.lines.length} lines (cut to ${MAX_OUTPUT_BYTES / 1024} KB):`
				: `Last ${tail.lines.length} lines:`
			return [header, where, label, ...tail.lines].join("\n")
		},
	}

	const processKill: AgentTool = {
		name: "process_kill",
		description:
			"Stop a background process: Ctrl+C for a terminal command (its terminal is closed if that does not stop it), " +
			"the whole process tree for one started with `background: true`.",
		inputSchema: {
			type: "object",
			properties: {
				id: { type: "string", description: "Process id from process_list or run_commands, e.g. p1." },
			},
			required: ["id"],
		},
		retryable: false,
		async execute(rawInput: unknown, context: AgentToolContext): Promise<string> {
			const input = (rawInput ?? {}) as { id?: unknown }
			const process = find(input.id, context)
			if (process.status !== "running") {
				return `${describeState(process, now())}; nothing to stop.`
			}
			const after = (await registry.kill(process.id)) ?? process
			return `${describeState(after, now())}: ${oneLine(after.command, 200)}\nLog: ${after.logPath}`
		},
	}

	return [processList, processOutput, processKill]
}
