import * as vscode from "vscode"

/**
 * Where "Run in worktree" puts a conversation's worktree (docs/task-worktrees.md):
 * `plinycode.worktrees.root`, else the CI Board's `plinycode.ci.worktreeRoot`.
 * Undefined when neither is set, which puts worktrees next to the repository.
 */
export function configuredTaskWorktreeFolder(): string | undefined {
	try {
		const config = vscode.workspace.getConfiguration("plinycode")
		return config.get<string>("worktrees.root", "")?.trim() || config.get<string>("ci.worktreeRoot", "")?.trim() || undefined
	} catch {
		// Hosts without VS Code's configuration API keep the default location.
		return undefined
	}
}
