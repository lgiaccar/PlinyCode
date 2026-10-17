import { accessSync, constants } from "node:fs"
import path from "node:path"
import { getHooksEnabledSafe } from "./hooks-utils"

type HookToggles = Record<string, boolean>

/** The state a hook toggle lives in: global hook files in a setting, workspace ones in workspace state. */
export interface HookToggleState {
	getGlobalSettingsKey(key: "globalHooksToggles"): HookToggles | undefined
	getGlobalSettingsKey(key: "hooksEnabled"): boolean | undefined
	getWorkspaceStateKey(key: "localHooksToggles"): HookToggles | undefined
	setGlobalState(key: "globalHooksToggles", value: HookToggles): void
	setWorkspaceState(key: "localHooksToggles", value: HookToggles): void
}

function normalizeHookPath(filePath: string): string {
	const resolved = path.resolve(filePath)
	// Windows paths are case-insensitive, and VS Code and Node disagree on the
	// drive letter's case ("d:\\" vs "D:\\").
	return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

function findToggle(toggles: HookToggles | undefined, target: string): boolean | undefined {
	for (const [hookPath, enabled] of Object.entries(toggles ?? {})) {
		if (normalizeHookPath(hookPath) === target) {
			return enabled
		}
	}
	return undefined
}

/**
 * Whether a hook file without a recorded toggle runs. The Cline-era runner
 * only ran extensionless hook files with the executable bit set on Unix, and
 * its toggle was `chmod -x`, so such a file left non-executable stays off.
 * Every other file (any file on Windows, any file with an extension) runs.
 */
function isEnabledByDefault(hookPath: string): boolean {
	if (process.platform === "win32" || path.extname(hookPath) !== "") {
		return true
	}
	try {
		accessSync(hookPath, constants.X_OK)
		return true
	} catch {
		return false
	}
}

/** The hook file's own toggle, ignoring the global `hooksEnabled` switch. */
export function isHookFileToggledOn(state: HookToggleState, hookPath: string): boolean {
	const target = normalizeHookPath(hookPath)
	return (
		findToggle(state.getWorkspaceStateKey("localHooksToggles"), target) ??
		findToggle(state.getGlobalSettingsKey("globalHooksToggles"), target) ??
		isEnabledByDefault(hookPath)
	)
}

/**
 * The engine's `hookFilter`: a hook file runs only while hooks are on and the
 * file is toggled on. State is read on every call, so a toggle applies to the
 * next hook run of a live session.
 */
export function createHookFileFilter(state: HookToggleState): (hookPath: string) => boolean {
	return (hookPath) => getHooksEnabledSafe(state.getGlobalSettingsKey("hooksEnabled")) && isHookFileToggledOn(state, hookPath)
}

function withoutPath(toggles: HookToggles | undefined, hookPath: string): HookToggles {
	const target = normalizeHookPath(hookPath)
	return Object.fromEntries(Object.entries(toggles ?? {}).filter(([key]) => normalizeHookPath(key) !== target))
}

/** Records a hook file's toggle, in the global setting or the workspace state. */
export function setHookFileToggle(state: HookToggleState, hookPath: string, isGlobal: boolean, enabled: boolean): void {
	if (isGlobal) {
		state.setGlobalState("globalHooksToggles", {
			...withoutPath(state.getGlobalSettingsKey("globalHooksToggles"), hookPath),
			[hookPath]: enabled,
		})
	} else {
		state.setWorkspaceState("localHooksToggles", {
			...withoutPath(state.getWorkspaceStateKey("localHooksToggles"), hookPath),
			[hookPath]: enabled,
		})
	}
}

/** Forgets a deleted hook file's toggle. */
export function clearHookFileToggle(state: HookToggleState, hookPath: string, isGlobal: boolean): void {
	if (isGlobal) {
		state.setGlobalState("globalHooksToggles", withoutPath(state.getGlobalSettingsKey("globalHooksToggles"), hookPath))
	} else {
		state.setWorkspaceState("localHooksToggles", withoutPath(state.getWorkspaceStateKey("localHooksToggles"), hookPath))
	}
}
