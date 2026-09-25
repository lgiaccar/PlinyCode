import os from "node:os"
import path from "node:path"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { fetch } from "@/shared/net"
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
import { DEFAULT_RELEASE_URL, downloadVsix, fetchRemoteManifest, findNewestRelease, resolveRemoteAsset } from "./release-remote"
import { isPrereleaseChannelEnabled, PRERELEASE_SETTING, UPDATE_SETTINGS_SECTION } from "./update-settings"

const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Version installed by the updater but not yet running. Lives in globalState so
 * every open window sees it and only one of them installs the release.
 */
const INSTALLED_VERSION_KEY = "plinycode.autoUpdate.installedVersion"

/** A release offered by one update source. */
interface UpdateCandidate {
	manifest: ReleaseManifest
	/** Where it came from, for logs and messages. */
	source: string
	/** Puts a verified copy of the .vsix in `stagingDir` and returns its path. */
	stage(stagingDir: string): Promise<string>
	openNotes?(): Thenable<unknown>
}

/**
 * Keeps PlinyCode current from GitHub Releases and, as a fallback, the shared
 * `PlinyCodeRelease` OneDrive folder (see release-remote.ts and
 * release-folder.ts). Checks shortly after startup and every few hours;
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
		const { candidates, errors } = await this.findCandidates()
		if (candidates.length === 0) {
			Logger.log(`[AutoUpdate] No update source available${errors.length ? `: ${errors.join("; ")}` : ""}`)
			if (interactive) {
				await this.showNoSource(errors)
			}
			return
		}
		if (errors.length) {
			Logger.warn(`[AutoUpdate] Some update sources failed: ${errors.join("; ")}`)
		}

		// Newest first; on a tie the earlier source (GitHub) wins.
		const newer = candidates
			.filter((candidate) => compareVersions(candidate.manifest.version, this.currentVersion) > 0)
			.sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))
		if (newer.length === 0) {
			const latest = candidates.map((c) => `${c.manifest.version} from ${c.source}`).join(", ")
			Logger.log(`[AutoUpdate] Up to date (running ${this.currentVersion}; ${latest})`)
			if (interactive) {
				void vscode.window.showInformationMessage(`PlinyCode is up to date (v${this.currentVersion}).`)
			}
			return
		}

		const version = newer[0].manifest.version
		const installed = this.context.globalState.get<string>(INSTALLED_VERSION_KEY) === version
		const candidate = installed ? newer[0] : await this.install(newer.filter((c) => c.manifest.version === version))

		if (interactive || this.promptedVersion !== version) {
			this.promptedVersion = version
			void this.promptReload(candidate)
		}
	}

	/** Installs from the first source that delivers a verified .vsix. */
	private async install(candidates: UpdateCandidate[]): Promise<UpdateCandidate> {
		const stagingDir = path.join(this.context.globalStorageUri.fsPath, "updates")
		const failures: string[] = []
		for (const candidate of candidates) {
			try {
				Logger.log(`[AutoUpdate] Installing ${candidate.manifest.version} from ${candidate.source}`)
				const vsix = await candidate.stage(stagingDir)
				await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsix))
				await this.context.globalState.update(INSTALLED_VERSION_KEY, candidate.manifest.version)
				return candidate
			} catch (error) {
				failures.push(`${candidate.source}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		throw new Error(failures.join("; "))
	}

	private async findCandidates(): Promise<{ candidates: UpdateCandidate[]; errors: string[] }> {
		const settings = vscode.workspace.getConfiguration(UPDATE_SETTINGS_SECTION)
		const candidates: UpdateCandidate[] = []
		const errors: string[] = []

		const addRemote = async (source: string, find: () => Promise<{ url: string; manifest: ReleaseManifest } | undefined>) => {
			try {
				const found = await find()
				if (found) {
					const { url, manifest } = found
					candidates.push({
						manifest,
						source,
						stage: (stagingDir) => downloadVsix(url, manifest, stagingDir, fetch),
						openNotes: manifest.notes
							? () => vscode.env.openExternal(vscode.Uri.parse(resolveRemoteAsset(url, manifest.notes as string)))
							: undefined,
					})
				}
			} catch (error) {
				errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const url = settings.get<string>("url", DEFAULT_RELEASE_URL).trim()
		if (url) {
			await addRemote(url, async () => {
				const manifest = await fetchRemoteManifest(url, fetch)
				return manifest && { url, manifest }
			})
			// Developers and testers also take the newest pre-release; the URL
			// above still serves official releases if the feed can't be read.
			if (isPrereleaseChannelEnabled()) {
				await addRemote("GitHub pre-releases", () => findNewestRelease(fetch))
			}
		}

		const folder = await findReleaseFolder({
			override: settings.get<string>("folder"),
			homeDir: os.homedir(),
			env: process.env,
			platform: process.platform,
		})
		if (folder) {
			try {
				const manifest = await readManifest(folder)
				candidates.push({
					manifest,
					source: folder,
					stage: (stagingDir) => stageVsix(folder, manifest, stagingDir),
					openNotes: manifest.notes
						? () =>
								vscode.commands.executeCommand(
									"markdown.showPreview",
									vscode.Uri.file(resolveInReleaseFolder(folder, manifest.notes as string)),
								)
						: undefined,
				})
			} catch (error) {
				errors.push(`${folder}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		return { candidates, errors }
	}

	/**
	 * The updater never downgrades, so someone who opts out while running a
	 * pre-release keeps it until an official release overtakes it.
	 */
	explainLeavingPrereleases(): void {
		if (this.currentVersion.includes("-")) {
			void vscode.window.showInformationMessage(
				`PlinyCode will stay on pre-release ${this.currentVersion} until a newer official release is published, then update to it.`,
			)
		}
	}

	private async promptReload(candidate: UpdateCandidate): Promise<void> {
		const reload = "Reload Now"
		const notes = "Release Notes"
		const actions = candidate.openNotes ? [reload, notes] : [reload]
		const choice = await vscode.window.showInformationMessage(
			`PlinyCode ${candidate.manifest.version} is installed. Reload the window to start using it.`,
			...actions,
		)
		if (choice === reload) {
			await vscode.commands.executeCommand("workbench.action.reloadWindow")
		} else if (choice === notes) {
			await candidate.openNotes?.()
		}
	}

	private async showNoSource(errors: string[]): Promise<void> {
		const reason = errors.length ? ` (${errors.join("; ")})` : ""
		const openSettings = "Open Settings"
		const choice = await vscode.window.showWarningMessage(
			`PlinyCode could not check for updates${reason}. It checks GitHub releases (plinycode.updates.url) and the synced "${RELEASE_FOLDER_NAME}" OneDrive folder (plinycode.updates.folder).`,
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
		if (vscode.workspace.getConfiguration(UPDATE_SETTINGS_SECTION).get<boolean>("enabled", true)) {
			void updater.check(false)
		}
	}

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((event) => {
			// User settings change in every open window; only the one the user is in reacts.
			if (!event.affectsConfiguration(`${UPDATE_SETTINGS_SECTION}.${PRERELEASE_SETTING}`) || !vscode.window.state.focused) {
				return
			}
			if (isPrereleaseChannelEnabled()) {
				// Opting in: fetch the newest pre-release now rather than in up to 6 hours.
				autoCheck()
			} else {
				updater.explainLeavingPrereleases()
			}
		}),
	)
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
