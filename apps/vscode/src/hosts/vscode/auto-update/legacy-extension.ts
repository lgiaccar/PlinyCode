import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

/**
 * PlinyCode 0.1.0 shipped under the extension ID `synopsys-plinycode.claude-dev`;
 * later releases are `synopsys-plinycode.plinycode-dev`. VS Code treats them as
 * unrelated extensions, so upgrading by hand leaves both installed, fighting over
 * the same `cline.*` commands and sidebar view.
 */
export const LEGACY_EXTENSION_ID = "synopsys-plinycode.claude-dev"

/**
 * Uninstalls the 0.1.0 build if it is still installed. Runs first in `activate`,
 * before anything that could fail because the old build registered the same
 * commands.
 */
export async function removeLegacyExtension(): Promise<void> {
	const legacy = vscode.extensions.getExtension(LEGACY_EXTENSION_ID)
	if (!legacy) {
		return
	}
	const version = legacy.packageJSON?.version ?? "unknown"
	try {
		await vscode.commands.executeCommand("workbench.extensions.uninstallExtension", LEGACY_EXTENSION_ID)
		Logger.log(`[AutoUpdate] Uninstalled the old PlinyCode ${version} (${LEGACY_EXTENSION_ID})`)
	} catch (error) {
		Logger.warn(`[AutoUpdate] Could not uninstall ${LEGACY_EXTENSION_ID}: ${error}`)
		void vscode.window.showWarningMessage(
			`An old PlinyCode ${version} (${LEGACY_EXTENSION_ID}) is also installed and conflicts with this one. Uninstall it from the Extensions view.`,
		)
		return
	}

	const reload = "Reload Now"
	const choice = await vscode.window.showInformationMessage(
		`Removed the old PlinyCode ${version}, which conflicted with this version. Reload the window to finish.`,
		reload,
	)
	if (choice === reload) {
		await vscode.commands.executeCommand("workbench.action.reloadWindow")
	}
}
