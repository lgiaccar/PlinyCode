/**
 * The rotating log file every `Logger` line goes to, next to the Output
 * channel: `<dataDir>/logs/plinycode.log`, rotated at 5 MB with the last
 * five files kept (`plinycode.log`, `plinycode.1.log` ... `plinycode.4.log`).
 *
 * Lines are queued and appended in the background, so logging never waits on
 * the disk, and a sink that cannot write reports it once through `onError`
 * (never through `Logger`, which would feed the failure back into the sink)
 * and drops the rest.
 */

import { resolveDataDirFromEnv } from "@shared/storage/storage-context"
import fs from "fs/promises"
import path from "path"

const LOGS_DIRNAME = "logs"
const LOG_FILENAME = "plinycode.log"
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
/** Files kept in all, the current one included. */
const DEFAULT_KEEP = 5

interface FileLogSinkOptions {
	/** Folder the log files go in. */
	dir: string
	/** Name of the current file; defaults to `plinycode.log`. */
	fileName?: string
	/** Bytes after which the current file is rotated; defaults to 5 MB. */
	maxBytes?: number
	/** Files kept in all, the current one included; defaults to 5. */
	keep?: number
	/** Told once, the first time a write fails. */
	onError?: (message: string) => void
}

export interface FileLogSink {
	readonly filePath: string
	/** Queues one line; returns at once. */
	write(line: string): void
	/** Resolves once every line queued so far has been written or dropped. */
	flush(): Promise<void>
}

/** Where the current log file goes: `<dataDir>/logs/plinycode.log`. */
export function logFilePath(dataDir?: string): string {
	return path.join(dataDir ?? resolveDataDirFromEnv(), LOGS_DIRNAME, LOG_FILENAME)
}

/** `plinycode.log` rotates to `plinycode.1.log`, then `plinycode.2.log`, ... */
function rotatedName(fileName: string, index: number): string {
	const extension = path.extname(fileName)
	return `${fileName.slice(0, fileName.length - extension.length)}.${index}${extension}`
}

export function createFileLogSink(options: FileLogSinkOptions): FileLogSink {
	const fileName = options.fileName ?? LOG_FILENAME
	const filePath = path.join(options.dir, fileName)
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
	const keep = Math.max(1, options.keep ?? DEFAULT_KEEP)
	const queue: string[] = []
	let draining: Promise<void> | undefined
	/** Bytes in the current file; measured once, counted afterwards. */
	let bytes: number | undefined
	let failed = false

	const rotate = async () => {
		// Shift the kept files up by one, dropping the oldest, then start afresh.
		await fs.rm(path.join(options.dir, rotatedName(fileName, keep - 1)), { force: true })
		for (let index = keep - 2; index >= 1; index -= 1) {
			await fs
				.rename(
					path.join(options.dir, rotatedName(fileName, index)),
					path.join(options.dir, rotatedName(fileName, index + 1)),
				)
				.catch(() => undefined)
		}
		if (keep > 1) {
			await fs.rename(filePath, path.join(options.dir, rotatedName(fileName, 1))).catch(() => undefined)
		} else {
			await fs.rm(filePath, { force: true })
		}
		bytes = 0
	}

	const writeChunk = async (chunk: string) => {
		if (bytes === undefined) {
			await fs.mkdir(options.dir, { recursive: true })
			bytes = await fs.stat(filePath).then(
				(stats) => stats.size,
				() => 0,
			)
		}
		const size = Buffer.byteLength(chunk, "utf8")
		if (bytes > 0 && bytes + size > maxBytes) {
			await rotate()
		}
		await fs.appendFile(filePath, chunk, "utf8")
		bytes = (bytes ?? 0) + size
	}

	const drain = async () => {
		while (queue.length > 0) {
			const chunk = `${queue.join("\n")}\n`
			queue.length = 0
			if (failed) {
				continue
			}
			try {
				await writeChunk(chunk)
			} catch (error) {
				failed = true
				options.onError?.(
					`[PlinyCode] Could not write the log file ${filePath}; file logging is off for this window: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		}
	}

	return {
		filePath,
		write(line: string) {
			if (failed) {
				return
			}
			queue.push(line)
			if (!draining) {
				draining = drain().finally(() => {
					draining = undefined
				})
			}
		},
		async flush() {
			while (draining) {
				await draining
			}
		},
	}
}
