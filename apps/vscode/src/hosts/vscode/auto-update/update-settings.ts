import * as vscode from "vscode"

/** VS Code settings section that holds every `plinycode.updates.*` setting. */
export const UPDATE_SETTINGS_SECTION = "plinycode.updates"

/** `plinycode.updates.prerelease`: also install `-test.N` pre-releases. */
export const PRERELEASE_SETTING = "prerelease"

/**
 * Whether this user installs pre-releases (developers and testers) as well as
 * official releases. Stored in the user's VS Code settings, so it persists
 * across restarts and follows Settings Sync.
 */
export function isPrereleaseChannelEnabled(): boolean {
	return vscode.workspace.getConfiguration(UPDATE_SETTINGS_SECTION).get<boolean>(PRERELEASE_SETTING, false) === true
}

export async function setPrereleaseChannelEnabled(enabled: boolean): Promise<void> {
	await vscode.workspace
		.getConfiguration(UPDATE_SETTINGS_SECTION)
		.update(PRERELEASE_SETTING, enabled, vscode.ConfigurationTarget.Global)
}
