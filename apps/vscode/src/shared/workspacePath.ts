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

/**
 * Compact UI label for a workspace path: parent folder + basename (e.g.
 * "dev1/PlinyCode"), so same-named folders under different parents stay
 * distinguishable. Falls back to the basename alone when there's no parent.
 */
export function workspacePathLabel(path: string, platform: Platform): string {
	const cleaned = (platform === "win32" ? path.replace(/\\/g, "/") : path).replace(/\/+$/, "")
	const segments = cleaned.split("/").filter(Boolean)
	if (segments.length === 0) {
		return path
	}
	if (segments.length === 1) {
		return segments[0]
	}
	return segments.slice(-2).join("/")
}

/** Workspace folder to show in history and exports (prefers stored root over task cwd). */
export function historyItemWorkspaceDisplayPath(item: {
	cwdOnTaskInitialization?: string
	workspaceRootOnTaskInitialization?: string
}): string {
	return (item.workspaceRootOnTaskInitialization || item.cwdOnTaskInitialization || "").trim()
}
