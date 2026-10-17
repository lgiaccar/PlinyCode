import type { HookStatusEvent } from "@plinycode/core"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { createHookStatusRows } from "./hook-status-rows"

// The rows the Cline-era hooks adapter (sdk/hooks-adapter.ts, removed when the
// engine took over the hook files) posted, captured from its
// buildHookStatusMessage before it was deleted. The webview's HookMessage
// parses this text, so the engine path must produce it byte for byte.
const LEGACY_ROW_TEXT = {
	preToolUseRunning: '{"hookName":"PreToolUse","toolName":"read_files","status":"running"}',
	preToolUseCancelled: '{"hookName":"PreToolUse","toolName":"read_files","status":"cancelled"}',
	postToolUseCompleted: '{"hookName":"PostToolUse","toolName":"editor","status":"completed"}',
	taskStartRunning: '{"hookName":"TaskStart","status":"running"}',
	taskStartFailed: '{"hookName":"TaskStart","status":"failed"}',
}

function event(overrides: Partial<HookStatusEvent> & Pick<HookStatusEvent, "hookName" | "status">): HookStatusEvent {
	return {
		hookPath: `/hooks/${overrides.hookName}.js`,
		eventName: overrides.hookName === "TaskStart" ? "agent_start" : "tool_call",
		...overrides,
	}
}

function setup(isBackgroundSession?: (sessionId: string | undefined) => boolean) {
	const rows: ClineMessage[] = []
	let nextTs = 100
	const listener = createHookStatusRows({
		emitRow: (message) => rows.push(message),
		nextMessageTs: () => nextTs++,
		isBackgroundSession,
	})
	return { rows, listener }
}

describe("createHookStatusRows", () => {
	it("posts the same hook_status row as the legacy adapter", () => {
		const { rows, listener } = setup()
		listener("s1", event({ hookName: "PreToolUse", toolName: "read_files", status: "running" }))
		listener(
			"s1",
			event({ hookName: "PreToolUse", toolName: "read_files", status: "cancelled", exitCode: 0, durationMs: 12 }),
		)
		listener("s1", event({ hookName: "PostToolUse", toolName: "editor", eventName: "tool_result", status: "completed" }))
		listener("s1", event({ hookName: "TaskStart", status: "running" }))
		listener("s1", event({ hookName: "TaskStart", status: "failed", exitCode: 1, error: "boom" }))

		expect(rows.map((row) => row.text)).toEqual([
			LEGACY_ROW_TEXT.preToolUseRunning,
			LEGACY_ROW_TEXT.preToolUseCancelled,
			LEGACY_ROW_TEXT.postToolUseCompleted,
			LEGACY_ROW_TEXT.taskStartRunning,
			LEGACY_ROW_TEXT.taskStartFailed,
		])
		for (const row of rows) {
			expect(row).toMatchObject({ type: "say", say: "hook_status", partial: false })
			expect(Object.keys(row).sort()).toEqual(["partial", "say", "text", "ts", "type"])
		}
	})

	it("gives the terminal status the running row's ts, so it replaces that row", () => {
		const { rows, listener } = setup()
		listener("s1", event({ hookName: "PreToolUse", toolName: "read_files", status: "running" }))
		listener("s1", event({ hookName: "PreToolUse", toolName: "read_files", status: "completed" }))
		listener("s1", event({ hookName: "PreToolUse", toolName: "read_files", status: "running" }))

		expect(rows.map((row) => row.ts)).toEqual([100, 100, 101])
	})

	it("pairs concurrent runs of the same hook first in, first out", () => {
		const { rows, listener } = setup()
		const run = { hookName: "PreToolUse", toolName: "search_codebase" } as const
		listener("s1", event({ ...run, status: "running" }))
		listener("s1", event({ ...run, status: "running" }))
		listener("s1", event({ hookName: "PreToolUse", toolName: "editor", status: "running" }))
		listener("s1", event({ ...run, status: "completed" }))
		listener("s1", event({ hookName: "PreToolUse", toolName: "editor", status: "failed" }))
		listener("s1", event({ ...run, status: "completed" }))

		expect(rows.map((row) => row.ts)).toEqual([100, 101, 102, 100, 102, 101])
	})

	it("mints a fresh ts for a terminal status with no running row", () => {
		const { rows, listener } = setup()
		listener("s1", event({ hookName: "TaskStart", status: "completed" }))
		expect(rows).toHaveLength(1)
		expect(rows[0].ts).toBe(100)
	})

	it("drops a background session's rows", () => {
		const background = new Set(["bg"])
		const { rows, listener } = setup((sessionId) => sessionId !== undefined && background.has(sessionId))
		listener("bg", event({ hookName: "PreToolUse", toolName: "editor", status: "running" }))
		listener("fg", event({ hookName: "PreToolUse", toolName: "editor", status: "running" }))
		listener("bg", event({ hookName: "PreToolUse", toolName: "editor", status: "completed" }))

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ ts: 101 })
	})

	it("keeps each session's running rows apart", () => {
		const emitRow = vi.fn()
		let nextTs = 1
		const listener = createHookStatusRows({ emitRow, nextMessageTs: () => nextTs++ })
		listener("a", event({ hookName: "PreToolUse", toolName: "editor", status: "running" }))
		listener("b", event({ hookName: "PreToolUse", toolName: "editor", status: "running" }))
		listener("b", event({ hookName: "PreToolUse", toolName: "editor", status: "completed" }))

		expect(emitRow.mock.calls.map(([row]) => row.ts)).toEqual([1, 2, 2])
	})
})
