import path from "node:path"
import { listHookConfigFiles } from "@plinycode/core"

/** A hook file the engine runs, as the Rules panel lists it. */
export interface HookFile {
	/** The event the file is named after, e.g. `PreToolUse`. */
	name: string
	absolutePath: string
}

export interface WorkspaceHookFiles {
	workspacePath: string
	files: HookFile[]
}

export interface HookFileListing {
	global: HookFile[]
	workspaces: WorkspaceHookFiles[]
}

function samePath(a: string, b: string): boolean {
	const left = path.resolve(a)
	const right = path.resolve(b)
	return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

function toHookFiles(entries: ReturnType<typeof listHookConfigFiles>): HookFile[] {
	return entries.map((entry) => ({ name: entry.fileName, absolutePath: entry.path }))
}

/**
 * The hook files the engine discovers: the global ones (`Documents/Cline/Hooks`,
 * `~/.cline/hooks`) and, per workspace folder, the ones only that workspace
 * adds (`.clinerules/hooks`, `.cline/hooks`).
 */
export function listHookFiles(workspacePaths: readonly string[]): HookFileListing {
	const global = toHookFiles(listHookConfigFiles())
	const isGlobal = (file: HookFile) => global.some((globalFile) => samePath(globalFile.absolutePath, file.absolutePath))
	return {
		global,
		workspaces: workspacePaths.map((workspacePath) => ({
			workspacePath,
			files: toHookFiles(listHookConfigFiles(workspacePath)).filter((file) => !isGlobal(file)),
		})),
	}
}

/**
 * Finds a listed hook file: by path when the request names one, otherwise the
 * first file for the event in that scope. Only a file the engine would run is
 * returned, so a request can never toggle or delete an arbitrary path.
 */
export function findHookFile(
	listing: HookFileListing,
	request: { hookName: string; hookPath?: string; isGlobal: boolean; workspacePath?: string },
): HookFile | undefined {
	const candidates = request.isGlobal
		? listing.global
		: (listing.workspaces.find(
				(workspace) => request.workspacePath && samePath(workspace.workspacePath, request.workspacePath),
			)?.files ?? [])
	const hookPath = request.hookPath
	return hookPath
		? candidates.find((file) => samePath(file.absolutePath, hookPath))
		: candidates.find((file) => file.name === request.hookName)
}
