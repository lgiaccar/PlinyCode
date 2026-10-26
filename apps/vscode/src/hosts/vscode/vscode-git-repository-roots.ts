import * as vscode from "vscode"

type GitRepository = {
	rootUri: vscode.Uri
}

type GitApi = {
	repositories: GitRepository[]
	getRepository(uri: vscode.Uri): GitRepository | null | undefined
}

type GitExtensionExports = {
	getAPI(version: 1): GitApi
}

/** Repository roots the built-in Git extension knows about (includes nested repos). */
export function listVscodeGitRepositoryRoots(): string[] {
	const gitExtension = vscode.extensions.getExtension<GitExtensionExports>("vscode.git")?.exports
	if (!gitExtension) {
		return []
	}
	const api = gitExtension.getAPI(1)
	const roots = new Set<string>()
	for (const repository of api.repositories) {
		roots.add(repository.rootUri.fsPath)
	}
	return [...roots]
}

/** Workspace folders plus every git root that contains a folder or is contained in one. */
export function workspaceGitDiscoveryPaths(workspaceFolders: readonly string[]): string[] {
	const paths = new Set(workspaceFolders)
	for (const root of listVscodeGitRepositoryRoots()) {
		for (const folder of workspaceFolders) {
			const folderLower = folder.toLowerCase()
			const rootLower = root.toLowerCase()
			if (folderLower.startsWith(rootLower) || rootLower.startsWith(folderLower)) {
				paths.add(root)
				paths.add(folder)
			}
		}
	}
	return [...paths]
}
