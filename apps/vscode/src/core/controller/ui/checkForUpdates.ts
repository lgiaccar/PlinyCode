import type { EmptyRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Runs "PlinyCode: Check for Updates" from the settings view. It returns
 * straight away: the check reports through VS Code notifications, some of
 * which wait for the user, so the webview is not kept waiting on it.
 */
export async function checkForUpdates(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	vscode.commands.executeCommand(ExtensionRegistryInfo.commands.CheckForUpdates).then(undefined, (error) => {
		Logger.error(`Failed to check for updates: ${error}`)
	})
	return Empty.create({})
}
