import { promises as fs } from "node:fs"
import path from "node:path"
import type { Workspace } from "@shared/proto/cline/workspace"
import { CODE_WORKSPACE_EXTENSION, isCodeWorkspaceFilePath, parseWorkspaceKind, type WorkspaceRef } from "@shared/workspaceRef"
import JSON5 from "json5"

/**
 * Resolves what a workspace *is* from what the user points at: a folder, or a
 * `.code-workspace` file, or the window VS Code has open. See
 * docs/workspace-conversations.md for the identity rules.
 */

/** A folder entry of a `.code-workspace` file, as VS Code writes it. */
interface CodeWorkspaceFolderEntry {
	path?: unknown
	uri?: unknown
	name?: unknown
}

/**
 * The absolute folder paths listed by a `.code-workspace` file, in order.
 * Relative entries resolve against the file's directory, `file:` URIs are
 * converted to paths, and anything else (remote URIs, malformed entries) is
 * skipped. The file is JSON with comments, so it is parsed as JSON5.
 *
 * @throws when the file cannot be read or is not a JSON object.
 */
export async function readCodeWorkspaceFolders(workspaceFilePath: string): Promise<string[]> {
	const raw = await fs.readFile(workspaceFilePath, "utf8")
	const parsed: unknown = JSON5.parse(raw)
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`${workspaceFilePath} is not a .code-workspace file`)
	}
	const entries = (parsed as { folders?: unknown }).folders
	if (!Array.isArray(entries)) {
		return []
	}
	const baseDir = path.dirname(workspaceFilePath)
	const folders: string[] = []
	for (const entry of entries as CodeWorkspaceFolderEntry[]) {
		const folder = codeWorkspaceEntryToPath(entry, baseDir)
		if (folder) {
			folders.push(folder)
		}
	}
	return folders
}

function codeWorkspaceEntryToPath(entry: CodeWorkspaceFolderEntry | null, baseDir: string): string | undefined {
	if (!entry || typeof entry !== "object") {
		return undefined
	}
	if (typeof entry.path === "string" && entry.path.trim()) {
		return path.resolve(baseDir, entry.path.trim())
	}
	if (typeof entry.uri === "string" && entry.uri.startsWith("file:")) {
		try {
			return path.normalize(decodeURIComponent(new URL(entry.uri).pathname.replace(/^\/([a-zA-Z]:)/, "$1")))
		} catch {
			return undefined
		}
	}
	return undefined
}

/**
 * Identity of the workspace at `targetPath`, which is a folder or a
 * `.code-workspace` file. A file listing a single folder is identified by that
 * folder, so opening the folder directly and opening the file bind the same
 * conversations. The folders are not checked for existence here; callers that
 * run a task in one validate it.
 *
 * @throws when the path is neither a directory nor a readable workspace file.
 */
export async function resolveWorkspaceRef(targetPath: string): Promise<WorkspaceRef> {
	const trimmed = targetPath.trim()
	if (!trimmed) {
		throw new Error("Workspace path is empty")
	}
	const absolute = path.resolve(trimmed)
	if (isCodeWorkspaceFilePath(absolute)) {
		const folders = await readCodeWorkspaceFolders(absolute)
		return workspaceRefFromFile(absolute, folders)
	}
	const stats = await fs.stat(absolute)
	if (!stats.isDirectory()) {
		throw new Error(`${absolute} is neither a folder nor a ${CODE_WORKSPACE_EXTENSION} file`)
	}
	return { path: absolute, kind: "folder", folders: [absolute] }
}

/** Identity for a `.code-workspace` file whose folders are already known. */
export function workspaceRefFromFile(workspaceFilePath: string, folders: string[]): WorkspaceRef {
	if (folders.length === 1) {
		return { path: folders[0], kind: "folder", folders: [folders[0]] }
	}
	return { path: workspaceFilePath, kind: "workspaceFile", folders }
}

/**
 * Identity of the workspace a window is open on, from what the host reports:
 * its folders and, when it was opened from a saved `.code-workspace` file,
 * that file. Undefined for an empty window.
 */
export function workspaceRefFromWindow(input: { paths: string[]; workspaceFile?: string }): WorkspaceRef | undefined {
	const folders = input.paths.map((entry) => entry.trim()).filter(Boolean)
	if (folders.length === 0) {
		return undefined
	}
	const workspaceFile = input.workspaceFile?.trim()
	if (workspaceFile && isCodeWorkspaceFilePath(workspaceFile)) {
		return workspaceRefFromFile(workspaceFile, folders)
	}
	return { path: folders[0], kind: "folder", folders: [folders[0]] }
}

export function workspaceRefToProto(ref: WorkspaceRef): Workspace {
	return {
		path: ref.path,
		kind: ref.kind,
		folders: [...ref.folders],
		lastUsedTs: ref.lastUsedTs ?? 0,
	}
}

export function workspaceRefFromProto(proto: Workspace): WorkspaceRef {
	return {
		path: proto.path,
		kind: parseWorkspaceKind(proto.kind),
		folders: [...(proto.folders ?? [])],
		...(proto.lastUsedTs ? { lastUsedTs: proto.lastUsedTs } : {}),
	}
}
