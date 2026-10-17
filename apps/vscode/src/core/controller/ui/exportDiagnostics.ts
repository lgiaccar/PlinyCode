import type { EmptyRequest } from "@shared/proto/cline/common"
import { Empty } from "@shared/proto/cline/common"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"

/**
 * Runs "PlinyCode: Export Diagnostics Bundle" from the settings view or an
 * error row. It returns straight away: the command reveals the folder and
 * reports through VS Code notifications, so the webview is not kept waiting.
 */
export async function exportDiagnostics(_controller: Controller, _request: EmptyRequest): Promise<Empty> {
	vscode.commands.executeCommand(ExtensionRegistryInfo.commands.ExportDiagnostics).then(undefined, (error) => {
		Logger.error(`Failed to export the diagnostics bundle: ${error}`)
	})
	return Empty.create({})
}
