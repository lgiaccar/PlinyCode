import path from "node:path"
import * as vscode from "vscode"

/**
 * Additional agent search paths declared in the workspace's .vscode/settings.json
 * under the `chat.agentFilesLocations` key (the same setting VS Code Copilot uses
 * to point at custom agent files). Returns absolute paths; relative entries are
 * resolved against the workspace root.
 *
 * Falls back to `github.copilot.chat.agentFilesLocations` (Copilot's own key) so
 * workspaces that already declare agent locations for Copilot are picked up
 * automatically. Returns [] when running outside VS Code or when the setting is
 * absent/empty.
 */
export function readAgentFileLocations(workspaceRoot: string | undefined): string[] {
	try {
		// PlinyCode's own setting (declared in package.json under "chat").
		const ownRaw = vscode.workspace.getConfiguration("chat").get<unknown[]>("agentFilesLocations", [])
		// Copilot's setting, used as a fallback when the workspace already lists
		// agent folders for Copilot under its own namespace.
		const copilotRaw = vscode.workspace.getConfiguration("github.copilot.chat").get<unknown[]>("agentFilesLocations", [])
		const raw = [...(Array.isArray(ownRaw) ? ownRaw : []), ...(Array.isArray(copilotRaw) ? copilotRaw : [])]
		if (raw.length === 0) {
			return []
		}
		return raw
			.filter((p): p is string => typeof p === "string" && p.length > 0)
			.map((p) => (path.isAbsolute(p) ? p : workspaceRoot ? path.join(workspaceRoot, p) : p))
	} catch {
		return []
	}
}
