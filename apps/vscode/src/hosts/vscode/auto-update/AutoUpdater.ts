import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { Logger } from "@/shared/services/Logger"
import {
	compareVersions,
	findReleaseFolder,
	RELEASE_FOLDER_NAME,
	type ReleaseManifest,
	readManifest,
	resolveInReleaseFolder,
	stageVsix,
} from "./release-folder"

const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Version installed by the updater but not yet running. Lives in globalState so
 * every open window sees it and only one of them installs the release.
 */
const INSTALLED_VERSION_KEY = "plinycode.autoUpdate.installedVersion"

/**
 * Keeps PlinyCode current from the shared `PlinyCodeRelease` OneDrive folder
 * (see release-folder.ts). Checks shortly after startup and every few hours;
 * automatic checks stay silent unless there is an update to offer.
 */
class AutoUpdater {
	private checking = false
	private promptedVersion: string | undefined

	constructor(private readonly context: vscode.ExtensionContext) {}

	private get currentVersion(): string {
		return this.context.extension.packageJSON.version
	}

	async forgetStaleInstall(): Promise<void> {
		// A window that starts on an older version than the updater installed means
		// the install did not take; forget it so the next check installs again.
		const installed = this.context.globalState.get<string>(INSTALLED_VERSION_KEY)
		if (installed && compareVersions(this.currentVersion, installed) !== 0) {
			await this.context.globalState.update(INSTALLED_VERSION_KEY, undefined)
		}
	}

	async check(interactive: boolean): Promise<void> {
		if (this.checking) {
			if (interactive) {
				void vscode.window.showInformationMessage("PlinyCode is already checking for updates.")
			}
			return
		}
		this.checking = true
		try {
			await this.runCheck(interactive)
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			Logger.warn(`[AutoUpdate] Update check failed: ${message}`)
			if (interactive) {
				void vscode.window.showErrorMessage(`PlinyCode update failed: ${message}`)
			}
		} finally {
			this.checking = false
		}
	}

	private async runCheck(interactive: boolean): Promise<void> {
		const settings = vscode.workspace.getConfiguration("plinycode.updates")
		const folder = await findReleaseFolder({
			override: settings.get<string>("folder"),
			homeDir: os.homedir(),
			env: process.env,
			platform: process.platform,
		})
		if (!folder) {
			Logger.log("[AutoUpdate] No synced release folder found")
			if (interactive) {
				await this.showFolderNotFound()
			}
			return
		}

		const manifest = await readManifest(folder)
		if (compareVersions(manifest.version, this.currentVersion) <= 0) {
			Logger.log(`[AutoUpdate] Up to date (running ${this.currentVersion}, latest ${manifest.version})`)
			if (interactive) {
				void vscode.window.showInformationMessage(`PlinyCode is up to date (v${this.currentVersion}).`)
			}
			return
		}

		if (this.context.globalState.get<string>(INSTALLED_VERSION_KEY) !== manifest.version) {
			Logger.log(`[AutoUpdate] Installing ${manifest.version} from ${folder}`)
			const stagingDir = path.join(this.context.globalStorageUri.fsPath, "updates")
			const vsix = await stageVsix(folder, manifest, stagingDir)
			await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsix))
			await this.context.globalState.update(INSTALLED_VERSION_KEY, manifest.version)
		}

		if (interactive || this.promptedVersion !== manifest.version) {
			this.promptedVersion = manifest.version
			void this.promptReload(folder, manifest)
		}
	}

	private async promptReload(folder: string, manifest: ReleaseManifest): Promise<void> {
		const reload = "Reload Now"
		const notes = "Release Notes"
		const actions = manifest.notes ? [reload, notes] : [reload]
		const choice = await vscode.window.showInformationMessage(
			`PlinyCode ${manifest.version} is installed. Reload the window to start using it.`,
			...actions,
		)
		if (choice === reload) {
			await vscode.commands.executeCommand("workbench.action.reloadWindow")
		} else if (choice === notes && manifest.notes) {
			const notesUri = vscode.Uri.file(resolveInReleaseFolder(folder, manifest.notes))
			await vscode.commands.executeCommand("markdown.showPreview", notesUri)
		}
	}

	private async showFolderNotFound(): Promise<void> {
		const remote = vscode.env.remoteName
			? ` This window runs on a remote host (${vscode.env.remoteName}), which cannot see your OneDrive; update from a local window instead.`
			: ""
		const openSettings = "Open Settings"
		const choice = await vscode.window.showWarningMessage(
			`PlinyCode could not find the shared "${RELEASE_FOLDER_NAME}" folder. Open the release link and choose "Add shortcut to My files" so OneDrive syncs it, or set plinycode.updates.folder to its path.${remote}`,
			openSettings,
		)
		if (choice === openSettings) {
			await vscode.commands.executeCommand("workbench.action.openSettings", "plinycode.updates")
		}
	}
}

export function registerAutoUpdater(context: vscode.ExtensionContext): void {
	const updater = new AutoUpdater(context)

	context.subscriptions.push(
		vscode.commands.registerCommand(ExtensionRegistryInfo.commands.CheckForUpdates, () => updater.check(true)),
	)

	const autoCheck = () => {
		if (vscode.workspace.getConfiguration("plinycode.updates").get<boolean>("enabled", true)) {
			void updater.check(false)
		}
	}
	const firstCheck = setTimeout(() => {
		void updater.forgetStaleInstall().then(autoCheck)
	}, FIRST_CHECK_DELAY_MS)
	const interval = setInterval(autoCheck, CHECK_INTERVAL_MS)
	context.subscriptions.push({
		dispose: () => {
			clearTimeout(firstCheck)
			clearInterval(interval)
		},
	})
}
