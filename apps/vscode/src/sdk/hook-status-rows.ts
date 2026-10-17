// Turns the engine's hook-file status events into the `hook_status` chat rows.
//
// The engine runs the hook files (core's hook-file-hooks.ts) and reports each
// one through `localRuntime.onHookStatus`: `running` before the file runs, then
// `completed`, `failed` or `cancelled`. The row is the one the Cline-era hooks
// adapter posted: `say: "hook_status"` with `{ hookName, toolName?, status }` as
// its text. The terminal status reuses the running row's ts, so it replaces
// that row in place instead of adding a second one (HookMessage.tsx renders it).

import type { HookStatusEvent } from "@plinycode/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { Logger } from "@shared/services/Logger"

/** Receives one session's hook status events. */
export type HookStatusRowListener = (sessionId: string | undefined, event: HookStatusEvent) => void

interface HookStatusRowDeps {
	emitRow: (message: ClineMessage) => void
	nextMessageTs: () => number
	/** A background session's hook rows are dropped instead of landing in the displayed task. */
	isBackgroundSession?: (sessionId: string | undefined) => boolean
}

/** The row text: the JSON the webview's HookMessage parses. */
function hookStatusRowText(event: Pick<HookStatusEvent, "hookName" | "toolName" | "status">): string {
	return JSON.stringify({
		hookName: event.hookName,
		...(event.toolName && { toolName: event.toolName }),
		status: event.status,
	})
}

export function createHookStatusRows(deps: HookStatusRowDeps): HookStatusRowListener {
	// Running rows waiting for their terminal status, oldest first per hook run
	// key: the same hook can run for two concurrent tool calls.
	const pending = new Map<string, number[]>()

	return (sessionId, event) => {
		const key = [sessionId ?? "", event.hookPath, event.eventName, event.toolName ?? ""].join("\0")
		let ts: number
		if (event.status === "running") {
			ts = deps.nextMessageTs()
			pending.set(key, [...(pending.get(key) ?? []), ts])
		} else {
			const queue = pending.get(key)
			ts = queue?.shift() ?? deps.nextMessageTs()
			if (queue && queue.length === 0) {
				pending.delete(key)
			}
			if (event.status === "failed") {
				Logger.warn(`[Hooks] ${event.hookName} hook failed (${event.hookPath}): ${event.error ?? "unknown error"}`)
			}
		}

		if (deps.isBackgroundSession?.(sessionId)) {
			return
		}
		deps.emitRow({
			ts,
			type: "say",
			say: "hook_status",
			text: hookStatusRowText(event),
			partial: false,
		})
	}
}
