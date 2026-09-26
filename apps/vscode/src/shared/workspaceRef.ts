import type { Platform } from "./ExtensionMessage"
import { workspacePathLabel, workspacePathsEqual } from "./workspacePath"

/**
 * How a workspace is identified. A `folder` workspace is a single directory; a
 * `workspaceFile` workspace is a `.code-workspace` file that lists several
 * folders. A `.code-workspace` file holding exactly one folder is identified by
 * that folder, so the two ways of opening it bind the same conversations.
 */
export type WorkspaceKind = "folder" | "workspaceFile"

/** A workspace a conversation can be bound to. Mirrors the `Workspace` proto message. */
export interface WorkspaceRef {
	/** Identity: the folder's absolute path, or the `.code-workspace` file's path. */
	path: string
	kind: WorkspaceKind
	/** Absolute folder paths; the first one is where conversations run. */
	folders: string[]
	/** When it was last used to start a conversation (ms since epoch). */
	lastUsedTs?: number
}

export const CODE_WORKSPACE_EXTENSION = ".code-workspace"

/** Most recently used workspaces remembered for quick selection. */
export const MAX_RECENT_WORKSPACES = 10

export function isCodeWorkspaceFilePath(filePath: string): boolean {
	return filePath.trim().toLowerCase().endsWith(CODE_WORKSPACE_EXTENSION)
}

export function parseWorkspaceKind(value: string | undefined): WorkspaceKind {
	return value === "workspaceFile" ? "workspaceFile" : "folder"
}

/** Two workspace identities refer to the same workspace. */
export function workspaceRefsEqual(
	a: Pick<WorkspaceRef, "path"> | undefined,
	b: Pick<WorkspaceRef, "path"> | undefined,
): boolean {
	if (!a || !b) {
		return false
	}
	return workspacePathsEqual(a.path, b.path)
}

/**
 * Compact label for a workspace: "parent/folder" for a folder, and the file
 * name without its extension for a `.code-workspace` file (e.g. "my-project").
 */
export function workspaceRefLabel(ref: Pick<WorkspaceRef, "path" | "kind">, platform: Platform): string {
	if (ref.kind === "workspaceFile") {
		const label = workspacePathLabel(ref.path, platform)
		const fileName = label.split("/").pop() ?? label
		return fileName.toLowerCase().endsWith(CODE_WORKSPACE_EXTENSION)
			? fileName.slice(0, -CODE_WORKSPACE_EXTENSION.length)
			: fileName
	}
	return workspacePathLabel(ref.path, platform)
}

/**
 * The workspace a history item is bound to: the explicit binding when the
 * conversation was recorded with one, otherwise the folder it ran in.
 */
export function historyItemWorkspaceRef(item: {
	workspacePath?: string
	workspaceKind?: WorkspaceKind
	cwdOnTaskInitialization?: string
	workspaceRootOnTaskInitialization?: string
}): Pick<WorkspaceRef, "path" | "kind"> | undefined {
	const bound = item.workspacePath?.trim()
	if (bound) {
		return { path: bound, kind: item.workspaceKind ?? "folder" }
	}
	const root = (item.workspaceRootOnTaskInitialization || item.cwdOnTaskInitialization || "").trim()
	return root ? { path: root, kind: "folder" } : undefined
}

/**
 * Put `ref` at the front of a most-recently-used list, dropping any earlier
 * entry for the same workspace and anything past the limit.
 */
export function pushRecentWorkspace(list: WorkspaceRef[], ref: WorkspaceRef, now = Date.now()): WorkspaceRef[] {
	const rest = list.filter((entry) => !workspaceRefsEqual(entry, ref))
	return [{ ...ref, lastUsedTs: now }, ...rest].slice(0, MAX_RECENT_WORKSPACES)
}
