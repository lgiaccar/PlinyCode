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

const ROUTER_CALL_LOG_FILENAME = "pliny-free-auto-calls.jsonl"

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
	/**
	 * Tokens the gateway reported for the call, summed over its usage events.
	 * Absent when the call ended without one (most failovers, and lines written
	 * before this field existed).
	 */
	usage?: RouterCallLogUsage
	/**
	 * USD the call cost: the gateway's figure or the catalog price. Zero for a
	 * free self-hosted model; absent when no usage was reported for a paid one.
	 */
	costUsd?: number
	/** The engine's id of the run the call belongs to, and its iteration, as in the session trace. */
	runId?: string
	iteration?: number
}

/** The token counts of `RouterCallLogRecord.usage`. */
export interface RouterCallLogUsage {
	inputTokens: number
	outputTokens: number
	cacheReadTokens: number
	cacheWriteTokens: number
	reasoningTokens?: number
	/** The provider reported no counts; these are a character-based estimate. */
	estimated?: boolean
}

/** Add one call's tokens to a running total; `estimated` sticks once any part was an estimate. */
export function addUsageTotals(total: RouterCallLogUsage | undefined, usage: RouterCallLogUsage): RouterCallLogUsage {
	const reasoningTokens =
		total?.reasoningTokens === undefined && usage.reasoningTokens === undefined
			? undefined
			: (total?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
	const estimated = total?.estimated === true || usage.estimated === true
	return {
		inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
		outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
		cacheReadTokens: (total?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
		cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
		...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
		...(estimated ? { estimated } : {}),
	}
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
