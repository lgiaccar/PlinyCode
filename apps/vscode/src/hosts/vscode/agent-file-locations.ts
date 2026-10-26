import path from "node:path"
import * as vscode from "vscode"

/**
 * Additional agent search paths declared in the workspace's .vscode/settings.json
 * under the `chat.agentFilesLocations` key (the same setting VS Code Copilot uses
 * to point at custom agent files). Returns absolute paths; relative entries are
 * resolved against the workspace root.
 *
 * Returns [] when running outside VS Code or when the setting is absent/empty.
 */
export function readAgentFileLocations(workspaceRoot: string | undefined): string[] {
	try {
		const config = vscode.workspace.getConfiguration("chat")
		const raw = config.get<string[]>("agentFilesLocations", [])
		if (!Array.isArray(raw) || raw.length === 0) {
			return []
		}
		return raw
			.filter((p): p is string => typeof p === "string" && p.length > 0)
			.map((p) => (path.isAbsolute(p) ? p : workspaceRoot ? path.join(workspaceRoot, p) : p))
	} catch {
		return []
	}
}
