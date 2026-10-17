import { resolveHooksConfigSearchPaths } from "@plinycode/core"
import path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { getCwd, getDesktopDir } from "@/utils/path"

/**
 * The hook files the Hooks tab can create, one per event the engine runs a
 * hook file for (`HookConfigFileName` in core's `hook-file-config.ts`, less
 * `PreCompact`, which has no event).
 */
export const VALID_HOOK_TYPES = [
	"TaskStart",
	"TaskResume",
	"TaskCancel",
	"TaskComplete",
	"TaskError",
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"SessionShutdown",
] as const

type HookType = (typeof VALID_HOOK_TYPES)[number]

export function isValidHookType(hookName: string): hookName is HookType {
	return VALID_HOOK_TYPES.includes(hookName as HookType)
}

/**
 * The workspace folder a workspace hook request is about: the folder with that
 * name in a multi-root window, otherwise the window's workspace.
 *
 * @throws Error if no workspace folder has that name
 */
export async function resolveHookWorkspacePath(workspaceName?: string): Promise<string> {
	if (workspaceName) {
		const workspacePaths = await HostProvider.workspace.getWorkspacePaths({})
		const targetWorkspace = workspacePaths.paths.find((p) => path.basename(p) === workspaceName)
		if (!targetWorkspace) {
			throw new Error(`Workspace "${workspaceName}" not found`)
		}
		return targetWorkspace
	}
	return getCwd(getDesktopDir())
}

/**
 * The directory a new hook file is written to: `Documents/Cline/Hooks` for a
 * global hook, `<workspace>/.clinerules/hooks` for a workspace one. The engine
 * reads both (and `~/.cline/hooks`, `<workspace>/.cline/hooks`).
 */
export async function resolveHooksDirectory(isGlobal: boolean, workspaceName?: string): Promise<string> {
	if (isGlobal) {
		return resolveHooksConfigSearchPaths()[0]
	}
	return path.join(await resolveHookWorkspacePath(workspaceName), ".clinerules", "hooks")
}
