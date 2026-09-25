/**
 * Append-only JSONL log of every call FreeAuto routes, one line per attempt,
 * next to the rules files. It exists to compare profiles and models over real
 * use (see scripts/summarize-free-auto-log.ts). Writing never blocks or fails a
 * call: errors are logged and dropped.
 */

import fs from "fs/promises"
import path from "path"
import { Logger } from "@/shared/services/Logger"
import { resolveDataDir } from "../legacy-state-reader"
import type { RouterEffort, RouterTier } from "./router-types"

export const ROUTER_CALL_LOG_FILENAME = "pliny-free-auto-calls.jsonl"

export interface RouterCallLogRecord {
	/** ISO time the call started. */
	ts: string
	sessionId: string
	subAgent: boolean
	profile: string
	route: string
	/** Classifier verdict for the turn, when the classifier ran and answered. */
	tier?: RouterTier
	think?: boolean
	/** On the turn's first call: why the classifier gave no verdict, when it ran and failed. */
	classifierError?: string
	/** Reasoning the router actually set on this model. */
	effort?: RouterEffort
	model: string
	estimatedTokens?: number
	/** Time to first content; absent when none arrived. */
	ttftMs?: number
	durationMs: number
	/** success: finished; failover: failed before output, next model tried; error: failed after output or for good. */
	outcome: "success" | "failover" | "error"
	error?: string
	/** The stream's finish reason (`stop`, `tool-calls`, `max-tokens`, …); absent when the stream ended without one. */
	finishReason?: string
	/** Visible text characters the call produced. */
	textChars?: number
	/** Characters on the reasoning channel; zero for a model that thinks in its content. */
	reasoningChars?: number
	/** Distinct tool calls in the reply. A `stop` with text and no tool calls is a turn-ending reply. */
	toolCalls?: number
}

export function callLogPath(dataDir?: string): string {
	return path.join(resolveDataDir(dataDir), ROUTER_CALL_LOG_FILENAME)
}

/** Queue one record. Writes are chained so lines never interleave. */
let pending: Promise<void> = Promise.resolve()

export function appendCallLog(record: RouterCallLogRecord, dataDir?: string): Promise<void> {
	const filePath = callLogPath(dataDir)
	pending = pending
		.then(() => fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8"))
		.catch((error) => Logger.warn(`[FreeAuto] Could not write call log ${filePath}: ${error}`))
	return pending
}
