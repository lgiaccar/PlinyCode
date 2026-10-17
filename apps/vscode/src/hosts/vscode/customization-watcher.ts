import {
	CustomizationChangeNotifier,
	getCustomizationWatchTargets,
	setCustomizationChangeNotifier,
} from "@core/context/instructions/user-instructions/customization-watcher"
import { getDocumentsPath } from "@core/storage/documents-path"
import { resolveClineDir, resolveGlobalRulesConfigPaths } from "@plinycode/shared/storage"
import os from "os"
import * as vscode from "vscode"
import { HostProvider } from "@/hosts/host-provider"
import { Logger } from "@/shared/services/Logger"

/**
 * Watches the rules, skills, hooks and agents folders with VS Code's file
 * watcher while the Rules panel is open (FileService.subscribeToCustomizationChanges).
 */
export function installCustomizationWatcher(context: vscode.ExtensionContext): void {
	// On Windows this asks PowerShell, so it is looked up once, the first time the panel opens.
	let documentsDir: Promise<string> | undefined
	const notifier = new CustomizationChangeNotifier({
		createWatcher: ({ base, pattern }) =>
			vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(base), pattern)),
		getTargets: async () =>
			getCustomizationWatchTargets({
				workspacePaths: (await HostProvider.workspace.getWorkspacePaths({})).paths,
				homeDir: os.homedir(),
				clineDir: resolveClineDir(),
				documentsDir: await (documentsDir ??= getDocumentsPath()),
				globalRulesDirs: resolveGlobalRulesConfigPaths(),
			}),
		onError: (error) => Logger.warn("[customization-watcher] Failed to watch rules, skills, hooks or agents:", error),
	})
	setCustomizationChangeNotifier(notifier)
	context.subscriptions.push(
		vscode.workspace.onDidChangeWorkspaceFolders(() => void notifier.restart()),
		{ dispose: () => setCustomizationChangeNotifier(undefined) },
	)
}
