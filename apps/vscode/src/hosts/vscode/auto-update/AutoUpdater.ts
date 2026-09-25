import path from "node:path"
import * as vscode from "vscode"
import { ExtensionRegistryInfo } from "@/registry"
import { fetch } from "@/shared/net"
import { Logger } from "@/shared/services/Logger"
import { compareVersions, type ReleaseManifest } from "./release-manifest"
import { DEFAULT_RELEASE_URL, downloadVsix, fetchRemoteManifest, findNewestRelease, resolveRemoteAsset } from "./release-remote"
import {
	isPrereleaseChannelEnabled,
	PRERELEASE_SETTING,
	setPrereleaseChannelEnabled,
	UPDATE_SETTINGS_SECTION,
} from "./update-settings"

const FIRST_CHECK_DELAY_MS = 30_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Version installed by the updater but not yet running. Lives in globalState so
 * every open window sees it and only one of them installs the release.
 */
const INSTALLED_VERSION_KEY = "plinycode.autoUpdate.installedVersion"

/** A release published on GitHub, with the latest.json URL it came from. */
interface UpdateCandidate {
	manifest: ReleaseManifest
	url: string
}

/**
 * Keeps PlinyCode current from GitHub Releases (see release-remote.ts). Checks
 * shortly after startup and every few hours; automatic checks stay silent
 * unless there is an update to offer.
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
		if (errors.length) {
			Logger.warn(`[AutoUpdate] Some release sources failed: ${errors.join("; ")}`)
		}
		if (candidates.length === 0) {
			if (errors.length) {
				if (interactive) {
					await this.showCheckFailed(errors)
				}
			} else {
				Logger.log(`[AutoUpdate] No release published on GitHub (running ${this.currentVersion})`)
				if (interactive) {
					await this.showNothingPublished()
				}
			}
			return
		}

		// Newest first; on a tie the official release URL wins over the pre-release feed.
		const newest = [...candidates].sort((a, b) => compareVersions(b.manifest.version, a.manifest.version))[0]
		if (compareVersions(newest.manifest.version, this.currentVersion) <= 0) {
			Logger.log(`[AutoUpdate] Up to date (running ${this.currentVersion}; newest on GitHub ${newest.manifest.version})`)
			if (interactive) {
				const published =
					compareVersions(newest.manifest.version, this.currentVersion) < 0
						? `; newest on GitHub: v${newest.manifest.version}`
						: ""
				void vscode.window.showInformationMessage(`PlinyCode is up to date (v${this.currentVersion}${published}).`)
			}
			return
		}

		const version = newest.manifest.version
		if (this.context.globalState.get<string>(INSTALLED_VERSION_KEY) !== version) {
			await this.install(newest)
		}
		if (interactive || this.promptedVersion !== version) {
			this.promptedVersion = version
			void this.promptReload(newest)
		}
	}

	private async install({ manifest, url }: UpdateCandidate): Promise<void> {
		const stagingDir = path.join(this.context.globalStorageUri.fsPath, "updates")
		Logger.log(`[AutoUpdate] Installing ${manifest.version} from ${url}`)
		const vsix = await downloadVsix(url, manifest, stagingDir, fetch)
		await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(vsix))
		await this.context.globalState.update(INSTALLED_VERSION_KEY, manifest.version)
	}

	/**
	 * Reads the official release and, for pre-release users, the newest
	 * pre-release. A release URL that answers 404 is not an error: nothing is
	 * published there yet.
	 */
	private async findCandidates(): Promise<{ candidates: UpdateCandidate[]; errors: string[] }> {
		const candidates: UpdateCandidate[] = []
		const errors: string[] = []

		const add = async (source: string, find: () => Promise<UpdateCandidate | undefined>) => {
			try {
				const found = await find()
				if (found) {
					candidates.push(found)
				}
			} catch (error) {
				errors.push(`${source}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}

		const settings = vscode.workspace.getConfiguration(UPDATE_SETTINGS_SECTION)
		const url = settings.get<string>("url", "").trim() || DEFAULT_RELEASE_URL
		await add(url, async () => {
			const manifest = await fetchRemoteManifest(url, fetch)
			return manifest && { url, manifest }
		})
		// Developers and testers also take the newest pre-release; the URL
		// above still serves official releases if the feed can't be read.
		if (isPrereleaseChannelEnabled()) {
			await add("GitHub pre-releases", () => findNewestRelease(fetch))
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

	private async promptReload({ manifest, url }: UpdateCandidate): Promise<void> {
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
			await vscode.env.openExternal(vscode.Uri.parse(resolveRemoteAsset(url, manifest.notes)))
		}
	}

	private async showNothingPublished(): Promise<void> {
		if (isPrereleaseChannelEnabled()) {
			void vscode.window.showInformationMessage(
				`No PlinyCode release is published on GitHub yet (running v${this.currentVersion}).`,
			)
			return
		}
		const include = "Include Pre-releases"
		const choice = await vscode.window.showInformationMessage(
			`No official PlinyCode release is published on GitHub yet (running v${this.currentVersion}). Developers and testers can also install pre-releases.`,
			include,
		)
		if (choice === include) {
			// The configuration listener runs the check once the setting changes.
			await setPrereleaseChannelEnabled(true)
		}
	}

	private async showCheckFailed(errors: string[]): Promise<void> {
		const openSettings = "Open Settings"
		const choice = await vscode.window.showWarningMessage(
			`PlinyCode could not check GitHub for updates: ${errors.join("; ")}`,
			openSettings,
		)
		if (choice === openSettings) {
			await vscode.commands.executeCommand("workbench.action.openSettings", UPDATE_SETTINGS_SECTION)
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
				// Opting in is a deliberate choice: check now, and say what was found,
				// rather than in up to 6 hours.
				void updater.check(true)
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
