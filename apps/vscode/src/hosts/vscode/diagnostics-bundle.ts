/**
 * "PlinyCode: Export Diagnostics Bundle" (docs/diagnostics-bundle.md): reads
 * what the editor and the controller know, hands it to the collector in
 * `sdk/diagnostics/diagnostics-bundle.ts`, then reveals the folder it wrote.
 */

import os from "os"
import path from "path"
import * as vscode from "vscode"
import type { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { ExtensionRegistryInfo } from "@/registry"
import { writeDiagnosticsBundle } from "@/sdk/diagnostics/diagnostics-bundle"
import { formatLastModelRequest } from "@/sdk/last-model-request"
import { resolveDataDir } from "@/sdk/legacy-state-reader"
import { Logger } from "@/shared/services/Logger"
import { SecretKeys } from "@/shared/storage/state-keys"

const SETTINGS_PREFIX = "plinycode."

export async function exportDiagnosticsBundle(
	context: vscode.ExtensionContext,
	controller: Controller | undefined,
): Promise<void> {
	const dataDir = resolveDataDir()
	const sessionId = controller?.task?.taskId
	let dir: string
	try {
		const result = await writeDiagnosticsBundle({
			dataDir,
			versions: collectVersions(),
			editorSettings: collectEditorSettings(context),
			...collectState(),
			excludedStateKeys: [...SecretKeys, "taskHistory"],
			sessionId,
			lastModelRequest: sessionId ? formatLastModelRequest(sessionId) : undefined,
			renderConversation:
				controller && sessionId
					? async () => (await controller.renderTaskMarkdown(sessionId, { includeToolOutput: true })).markdown
					: undefined,
			mcpSettingsPath: await mcpSettingsPath(controller, dataDir),
			ciBoardPath: path.join(dataDir, "ci-board.json"),
		})
		dir = result.dir
		Logger.log(`[diagnostics] Wrote ${result.included.length} files to ${dir}; not available: ${result.missing.length}`)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		Logger.error(`[diagnostics] Could not write the diagnostics bundle: ${message}`)
		void vscode.window.showErrorMessage(`PlinyCode could not write the diagnostics bundle: ${message}`)
		return
	}

	await vscode.commands
		.executeCommand("revealFileInOS", vscode.Uri.file(path.join(dir, "README.md")))
		.then(undefined, (error) => {
			Logger.warn(`[diagnostics] Could not reveal ${dir}: ${error}`)
		})
	const choice = await vscode.window.showInformationMessage(
		`PlinyCode wrote a diagnostics bundle to ${dir}. Check it for anything sensitive before sharing it.`,
		"Open folder",
	)
	if (choice === "Open folder") {
		await vscode.env.openExternal(vscode.Uri.file(dir))
	}
}

/** Versions only: nothing here names the machine or the user. */
function collectVersions(): Record<string, unknown> {
	return {
		plinycode: ExtensionRegistryInfo.version,
		extensionId: ExtensionRegistryInfo.id,
		editor: vscode.env.appName,
		editorVersion: vscode.version,
		uiKind: vscode.env.uiKind === vscode.UIKind.Web ? "web" : "desktop",
		remoteName: vscode.env.remoteName ?? null,
		language: vscode.env.language,
		os: process.platform,
		osRelease: os.release(),
		arch: process.arch,
		node: process.versions.node,
		electron: process.versions.electron ?? null,
	}
}

/**
 * The effective value of every `plinycode.*` setting the extension declares,
 * read through the configuration API so defaults, user and workspace values
 * resolve as the extension sees them.
 */
function collectEditorSettings(context: vscode.ExtensionContext): Record<string, unknown> {
	const configuration = vscode.workspace.getConfiguration(SETTINGS_PREFIX.slice(0, -1))
	const settings: Record<string, unknown> = {}
	for (const id of declaredSettingIds(context)) {
		settings[id] = configuration.get(id.slice(SETTINGS_PREFIX.length))
	}
	return settings
}

function declaredSettingIds(context: vscode.ExtensionContext): string[] {
	const contributes = (context.extension.packageJSON as { contributes?: { configuration?: unknown } }).contributes
	const sections = Array.isArray(contributes?.configuration) ? contributes.configuration : [contributes?.configuration]
	const ids: string[] = []
	for (const section of sections) {
		const properties = (section as { properties?: Record<string, unknown> } | undefined)?.properties
		for (const id of Object.keys(properties ?? {})) {
			if (id.startsWith(SETTINGS_PREFIX)) {
				ids.push(id)
			}
		}
	}
	return ids.sort()
}

function collectState(): { globalState: Record<string, unknown>; workspaceState?: Record<string, unknown> } {
	try {
		const manager = StateManager.get()
		return {
			globalState: manager.getAllGlobalStateEntries(),
			workspaceState: manager.getAllWorkspaceStateEntries(),
		}
	} catch (error) {
		return { globalState: { note: `state not available: ${error instanceof Error ? error.message : String(error)}` } }
	}
}

async function mcpSettingsPath(controller: Controller | undefined, dataDir: string): Promise<string> {
	try {
		const fromHub = await controller?.mcpHub?.getMcpSettingsFilePath()
		if (fromHub) {
			return fromHub
		}
	} catch (error) {
		Logger.warn(`[diagnostics] McpHub gave no settings path: ${error}`)
	}
	return path.join(dataDir, "settings", "cline_mcp_settings.json")
}
