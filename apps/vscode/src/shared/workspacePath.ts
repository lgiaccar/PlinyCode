import type { Platform } from "./ExtensionMessage"

/**
 * Basename of a workspace path for compact UI labels, with platform-aware
 * separator handling so Windows paths do not render as one long segment.
 */
export function workspacePathBasename(path: string, platform: Platform): string {
	let cleaned = platform === "win32" ? path.replace(/\\/g, "/") : path
	cleaned = cleaned.replace(/\/+$/, "")
	return cleaned.split("/").pop() || path
}

/** Workspace folder to show in history and exports (prefers stored root over task cwd). */
export function historyItemWorkspaceDisplayPath(item: {
	cwdOnTaskInitialization?: string
	workspaceRootOnTaskInitialization?: string
}): string {
	return (item.workspaceRootOnTaskInitialization || item.cwdOnTaskInitialization || "").trim()
}
