import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	clearHookFileToggle,
	createHookFileFilter,
	type HookToggleState,
	isHookFileToggledOn,
	setHookFileToggle,
} from "./hook-toggles"

function createState(
	initial: { hooksEnabled?: boolean; global?: Record<string, boolean>; local?: Record<string, boolean> } = {},
) {
	const values = {
		hooksEnabled: initial.hooksEnabled,
		globalHooksToggles: initial.global ?? {},
		localHooksToggles: initial.local ?? {},
	}
	const state = {
		values,
		getGlobalSettingsKey: (key: "globalHooksToggles" | "hooksEnabled") => values[key],
		getWorkspaceStateKey: (_key: "localHooksToggles") => values.localHooksToggles,
		setGlobalState: (_key: "globalHooksToggles", value: Record<string, boolean>) => {
			values.globalHooksToggles = value
		},
		setWorkspaceState: (_key: "localHooksToggles", value: Record<string, boolean>) => {
			values.localHooksToggles = value
		},
	}
	return state as typeof state & HookToggleState
}

describe("hook toggles", () => {
	let tempDir: string
	let hookPath: string

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "hook-toggles-"))
		hookPath = path.join(tempDir, "PreToolUse.js")
		await fs.writeFile(hookPath, "console.log('{}')\n")
	})

	afterEach(async () => {
		await fs.rm(tempDir, { recursive: true, force: true })
	})

	it("runs a hook file with no toggle while hooks are on", () => {
		expect(createHookFileFilter(createState())(hookPath)).toBe(true)
		expect(createHookFileFilter(createState({ hooksEnabled: true }))(hookPath)).toBe(true)
	})

	it("skips every hook file while the hooksEnabled switch is off, whatever its toggle", () => {
		const state = createState({ hooksEnabled: false, global: { [hookPath]: true } })
		expect(createHookFileFilter(state)(hookPath)).toBe(false)
		// The Hooks tab still shows the file's own toggle.
		expect(isHookFileToggledOn(state, hookPath)).toBe(true)
	})

	it("skips a hook file toggled off, globally or in the workspace", () => {
		expect(createHookFileFilter(createState({ global: { [hookPath]: false } }))(hookPath)).toBe(false)
		expect(createHookFileFilter(createState({ local: { [hookPath]: false } }))(hookPath)).toBe(false)
	})

	it("reads the toggles on every call, so a toggle applies to a live session", () => {
		const state = createState()
		const filter = createHookFileFilter(state)
		expect(filter(hookPath)).toBe(true)
		setHookFileToggle(state, hookPath, false, false)
		expect(filter(hookPath)).toBe(false)
		setHookFileToggle(state, hookPath, false, true)
		expect(filter(hookPath)).toBe(true)
		state.values.hooksEnabled = false
		expect(filter(hookPath)).toBe(false)
	})

	it("records a toggle in the global setting or the workspace state, replacing the previous one", () => {
		const state = createState()
		setHookFileToggle(state, hookPath, true, false)
		setHookFileToggle(state, hookPath, true, true)
		expect(state.values.globalHooksToggles).toEqual({ [hookPath]: true })
		expect(state.values.localHooksToggles).toEqual({})

		setHookFileToggle(state, hookPath, false, false)
		expect(state.values.localHooksToggles).toEqual({ [hookPath]: false })

		clearHookFileToggle(state, hookPath, true)
		clearHookFileToggle(state, hookPath, false)
		expect(state.values.globalHooksToggles).toEqual({})
		expect(state.values.localHooksToggles).toEqual({})
	})

	it.runIf(process.platform === "win32")("matches toggles case-insensitively on Windows", () => {
		const state = createState({ local: { [hookPath.toUpperCase()]: false } })
		expect(createHookFileFilter(state)(hookPath.toLowerCase())).toBe(false)

		setHookFileToggle(state, hookPath.toLowerCase(), false, true)
		expect(Object.keys(state.values.localHooksToggles)).toEqual([hookPath.toLowerCase()])
	})

	// The Cline-era runner only ran executable extensionless hook files on Unix,
	// and toggled them with chmod; a file left non-executable stays off until
	// it is toggled on.
	it.runIf(process.platform !== "win32")(
		"treats a non-executable extensionless hook file without a toggle as off",
		async () => {
			const legacyHook = path.join(tempDir, "TaskStart")
			await fs.writeFile(legacyHook, "#!/usr/bin/env node\n", { mode: 0o644 })
			const state = createState()
			expect(createHookFileFilter(state)(legacyHook)).toBe(false)

			await fs.chmod(legacyHook, 0o755)
			expect(createHookFileFilter(state)(legacyHook)).toBe(true)

			await fs.chmod(legacyHook, 0o644)
			setHookFileToggle(state, legacyHook, true, true)
			expect(createHookFileFilter(state)(legacyHook)).toBe(true)
		},
	)

	it.runIf(process.platform !== "win32")("runs a non-executable hook file with an extension", async () => {
		await fs.chmod(hookPath, 0o644)
		expect(createHookFileFilter(createState())(hookPath)).toBe(true)
	})
})
