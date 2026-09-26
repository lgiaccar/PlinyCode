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

function normalizeWorkspacePathForComparison(path: string): string {
	return path.trim().replace(/\\/g, "/").replace(/\/+$/, "")
}

/** A Windows path: drive letter (`C:/…`) or UNC (`//server/share`). */
function isWindowsStylePath(path: string): boolean {
	return /^[a-zA-Z]:\//.test(path) || path.startsWith("//")
}

/**
 * Whether two workspace paths name the same location, regardless of separator
 * style or a trailing slash. Windows-style paths compare case-insensitively,
 * like `arePathsEqual` in the extension host, so the webview (which does not
 * know the host platform) reaches the same verdict as the extension.
 */
export function workspacePathsEqual(a: string | undefined, b: string | undefined): boolean {
	const left = normalizeWorkspacePathForComparison(a ?? "")
	const right = normalizeWorkspacePathForComparison(b ?? "")
	if (!left || !right) {
		return left === right
	}
	if (isWindowsStylePath(left) || isWindowsStylePath(right)) {
		return left.toLowerCase() === right.toLowerCase()
	}
	return left === right
}
