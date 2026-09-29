import { ensureChatWorkspace } from "@plinycode/core"
import type { WorkspaceRef } from "@shared/workspaceRef"
import { RecentWorkspacesStore } from "@/core/workspace/recent-workspaces-store"
import { WorkspaceRootManager } from "@/core/workspace/WorkspaceRootManager"
import { workspaceRefFromWindow } from "@/core/workspace/workspace-identity"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"
import { getDesktopDir } from "@/utils/path"
import { resolveWorkspaceManagerPaths } from "./workspace-root"

export interface SdkWorkspaceRootResolverOptions {
	/**
	 * The workspace the displayed task runs in, if any — while set,
	 * getWorkspaceRoot() resolves here instead of the window's workspace.
	 */
	getActiveTaskWorkspace: () => { workspace?: WorkspaceRef; cwd: string } | undefined
	/** Called whenever getWorkspaceRoot() resolves, to keep a synchronous snapshot warm. */
	onWorkspaceRootResolved: (workspaceRoot: string) => void
}

/**
 * Resolves the user's workspace root directory and the WorkspaceRootManager
 * built from it, plus the no-workspace fallback (the SDK's shared chat
 * workspace) and the window's own workspace identity. Extracted from
 * SdkController, which owns the recentWorkspaces store and the synchronous
 * lastKnownWorkspaceRoot snapshot that callers still read directly.
 */
export class SdkWorkspaceRootResolver {
	/** Most recently used workspaces, shared with the other windows through a file. */
	readonly recentWorkspaces = new RecentWorkspacesStore()
	private windowWorkspaceRecorded = false
	private noWorkspaceFallbackPromise?: Promise<string>
	private _workspaceManager?: WorkspaceRootManager
	private _workspaceManagerPathsKey?: string

	constructor(private readonly options: SdkWorkspaceRootResolverOptions) {}

	/**
	 * Get the user's workspace root directory.
	 *
	 * In VSCode this resolves to `vscode.workspace.workspaceFolders[0]` via
	 * `HostProvider.workspace.getWorkspacePaths()`. If no workspace folder is
	 * open, it falls back to the SDK's shared chat workspace (see
	 * getNoWorkspaceFallback).
	 * This avoids using the VS Code extension host's `process.cwd()` (often `/`),
	 * which produces invalid SDK workspace metadata with an empty hint.
	 */
	async getWorkspaceRoot(): Promise<string> {
		const activeTaskWorkspace = this.options.getActiveTaskWorkspace()
		if (activeTaskWorkspace) {
			this.options.onWorkspaceRootResolved(activeTaskWorkspace.cwd)
			return activeTaskWorkspace.cwd
		}
		try {
			const { paths } = await HostProvider.workspace.getWorkspacePaths({})
			const workspaceRoot = paths?.find((workspacePath) => workspacePath.trim().length > 0)
			if (workspaceRoot) {
				this.options.onWorkspaceRootResolved(workspaceRoot)
				return workspaceRoot
			}
		} catch (error) {
			Logger.warn("[SdkController] Failed to get workspace paths, using the no-workspace fallback:", error)
		}
		const fallback = await this.getNoWorkspaceFallback()
		this.options.onWorkspaceRootResolved(fallback)
		return fallback
	}

	/**
	 * The workspace this window is open on: its folder, or its .code-workspace
	 * file when that lists several folders. Undefined in an empty window. The
	 * first resolution also records it as recently used, so the other windows
	 * offer it in their pickers.
	 */
	async getWindowWorkspace(): Promise<WorkspaceRef | undefined> {
		try {
			const { paths, workspaceFile } = await HostProvider.workspace.getWorkspacePaths({})
			const workspace = workspaceRefFromWindow({ paths: paths ?? [], workspaceFile })
			if (workspace && !this.windowWorkspaceRecorded) {
				this.windowWorkspaceRecorded = true
				void this.recentWorkspaces.touch(workspace)
			}
			return workspace
		} catch (error) {
			Logger.warn("[SdkController] Failed to resolve the window workspace:", error)
			return undefined
		}
	}

	/**
	 * Directory used when no workspace folder is open: the SDK's shared chat
	 * workspace (`~/.cline/data/workspaces/chat`, seeded with an AGENTS.md
	 * etiquette file), matching how the desktop app and CLI host sessions
	 * started without a project. Desktop is only a last resort when the chat
	 * workspace cannot be created. Memoized so repeated no-workspace calls
	 * don't re-touch the filesystem.
	 */
	getNoWorkspaceFallback(): Promise<string> {
		this.noWorkspaceFallbackPromise ??= (async () => {
			try {
				return await ensureChatWorkspace()
			} catch (error) {
				Logger.warn("[SdkController] Failed to prepare the chat workspace, falling back to Desktop:", error)
				// Don't memoize the degraded result; retry the chat workspace next time.
				this.noWorkspaceFallbackPromise = undefined
				return getDesktopDir()
			}
		})()
		return this.noWorkspaceFallbackPromise
	}

	/**
	 * Build (or reuse) the WorkspaceRootManager for @-mention file search,
	 * seeded from the active task's workspace folders when set, otherwise the
	 * window's workspace folders, falling back to `fallbackRoot` (the caller's
	 * lastKnownWorkspaceRoot / no-workspace fallback) when the host reports no
	 * workspace folders. Rebuilt only when the resolved path set changes.
	 */
	async ensureWorkspaceManager(fallbackRoot: string | undefined): Promise<WorkspaceRootManager | undefined> {
		try {
			// A task started in another workspace than the window's searches and
			// resolves @-mentions in that workspace's folders, not the window's.
			const activeTaskWorkspace = this.options.getActiveTaskWorkspace()
			const taskFolders = activeTaskWorkspace?.workspace?.folders.filter((folder) => folder.trim()) ?? []
			const { paths } = taskFolders.length > 0 ? { paths: taskFolders } : await HostProvider.workspace.getWorkspacePaths({})
			// When no workspace folder is open, fall back to the active session's
			// working directory (if known) or the shared chat workspace, the same
			// root getWorkspaceRoot() gives sessions. The legacy Controller always
			// seeded its manager with a fallback root (setupWorkspaceManager →
			// getCwd(getDesktopDir())), so @-mention file search kept working in
			// an empty window; returning undefined here instead made searchFiles
			// emit task.mention_failed (workspace_unavailable) with zero results.
			const validPaths = resolveWorkspaceManagerPaths(paths, fallbackRoot ?? (await this.getNoWorkspaceFallback()))
			if (validPaths.length === 0) {
				return undefined
			}
			// Rebuild only when the set of workspace folders changes
			const pathsKey = JSON.stringify(validPaths)
			if (!this._workspaceManager || this._workspaceManagerPathsKey !== pathsKey) {
				this._workspaceManager = await WorkspaceRootManager.fromPaths(validPaths)
				this._workspaceManagerPathsKey = pathsKey
			}
			return this._workspaceManager
		} catch (error) {
			Logger.warn("[SdkController] Failed to build workspace manager:", error)
			return undefined
		}
	}
}
