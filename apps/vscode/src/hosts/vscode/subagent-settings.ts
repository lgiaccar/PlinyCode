import type { SubAgentLimits } from "@plinycode/core"
import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.subagents.*` setting. */
const SUBAGENT_SETTINGS_SECTION = "plinycode.subagents"

/** Defaults and bounds, matching `contributes.configuration` in package.json. */
const LIMIT_BOUNDS = {
	maxDepth: { fallback: 1, min: 1, max: 2 },
	maxConcurrent: { fallback: 3, min: 1, max: 6 },
	maxIterations: { fallback: 40, min: 5, max: 200 },
} as const satisfies Record<keyof SubAgentLimits, { fallback: number; min: number; max: number }>

function bounded(value: unknown, { fallback, min, max }: { fallback: number; min: number; max: number }): number {
	const number = typeof value === "number" ? value : Number(value)
	if (value === undefined || value === null || value === "" || !Number.isFinite(number)) {
		return fallback
	}
	return Math.min(max, Math.max(min, Math.floor(number)))
}

/**
 * The `plinycode.subagents.*` settings as the engine's `subAgentLimits`:
 * delegation depth, sub-agent runs in flight per parent and iterations per
 * run. Read when a session starts, so a change applies to the next one.
 */
export function getSubAgentLimits(): Required<SubAgentLimits> {
	let config: vscode.WorkspaceConfiguration | undefined
	try {
		config = vscode.workspace.getConfiguration(SUBAGENT_SETTINGS_SECTION)
	} catch {
		// Hosts without VS Code's configuration API keep the defaults.
	}
	return {
		maxDepth: bounded(config?.get("maxDepth"), LIMIT_BOUNDS.maxDepth),
		maxConcurrent: bounded(config?.get("maxConcurrent"), LIMIT_BOUNDS.maxConcurrent),
		maxIterations: bounded(config?.get("maxIterations"), LIMIT_BOUNDS.maxIterations),
	}
}
