/**
 * Append-only JSONL log of how every routed run ended, one line per run, next
 * to the call log. The call log says which model answered each call; this file
 * says whether the run then stopped on a tool-free reply, right after which
 * tool, and whether the completion guard or judge had to step in — the numbers
 * that show which models stop early (see scripts/summarize-free-auto-log.ts).
 * Writing never blocks or fails a run: errors are logged and dropped.
 */

import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "../legacy-state-reader"
import type { RouterRunState } from "./router-health"

export const ROUTER_RUN_LOG_FILENAME = "pliny-free-auto-runs.jsonl"

/** How a run came to an end. */
export type RouterRunEnding =
	/** The model replied without a tool call and no guard objected. */
	| "text"
	/** A tool with `lifecycle.completesRun` (e.g. `submit_and_exit`) was called. */
	| "completion-tool"
	| "error"
	| "aborted"

export interface RouterRunLogRecord extends Omit<RouterRunState, "guardRules"> {
	/** ISO time the run ended. */
	ts: string
	sessionId: string
	subAgent: boolean
	profile: string
	/** Concrete model of the run's last call, when any call was made. */
	model?: string
	route?: string
	/** LLM calls the run made. */
	calls: number
	iterations: number
	ending: RouterRunEnding
	guardRules: string[]
	durationMs: number
}

export function runLogPath(dataDir?: string): string {
	return path.join(resolveDataDir(dataDir), ROUTER_RUN_LOG_FILENAME)
}

/** Queue one record. Writes are chained so lines never interleave. */
let pending: Promise<void> = Promise.resolve()

export function appendRunLog(record: RouterRunLogRecord, dataDir?: string): Promise<void> {
	const filePath = runLogPath(dataDir)
	pending = pending
		.then(() => fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8"))
		.catch((error) => Logger.warn(`[FreeAuto] Could not write run log ${filePath}: ${error}`))
	return pending
}
