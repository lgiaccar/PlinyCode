export interface UpdateStatus {
	currentVersion: string;
	phase:
		| "idle"
		| "checking"
		| "available"
		| "downloading"
		| "ready"
		| "installing"
		| "error"
		| "unsupported";
	version?: string;
	percent?: number;
	message?: string;
}
export interface UpdateInfo {
	version: string;
	files: { url: string; sha512: string; size?: number }[];
}
export interface UpdateTransport {
	autoDownload: boolean;
	autoInstallOnAppQuit: boolean;
	allowDowngrade: boolean;
	allowPrerelease: boolean;
	disableDifferentialDownload: boolean;
	on(event: string, listener: (...args: any[]) => void): unknown;
	setFeedURL(options: { provider: "generic"; url: string }): void;
	checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
	downloadUpdate(): Promise<string[]>;
	quitAndInstall(silent?: boolean, restart?: boolean): void;
}
const repo = "https://github.com/lgiaccar/PlinyCode";
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function newer(a: string, b: string): boolean {
	if (!versionPattern.test(a) || !versionPattern.test(b)) return false;
	const left = a.split(".").map(Number),
		right = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) return left[i] > right[i];
	}
	return false;
}
interface Release {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
	assets: { name: string }[];
}
export function selectRelease(
	releases: Release[],
	current: string,
	platform: string,
) {
	const metadata = platform === "win32" ? "latest.yml" : "latest-linux.yml";
	return releases
		.filter(
			(release) =>
				!release.draft &&
				!release.prerelease &&
				release.tag_name.startsWith("desktop-v") &&
				newer(release.tag_name.slice(9), current) &&
				release.assets.some((asset) => asset.name === metadata),
		)
		.sort((a, b) =>
			newer(a.tag_name.slice(9), b.tag_name.slice(9)) ? -1 : 1,
		)[0];
}
export async function discoverRelease(
	current: string,
	platform: string,
	fetcher: (url: string, options?: RequestInit) => Promise<Response> = fetch,
) {
	const releases: Release[] = [];
	// Desktop is a separate release channel; never use the editor's /releases/latest feed.
	for (let page = 1; page <= 3; page++) {
		const response = await fetcher(
			`https://api.github.com/repos/lgiaccar/PlinyCode/releases?per_page=100&page=${page}`,
			{
				headers: { Accept: "application/vnd.github+json" },
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			},
		);
		if (!response.ok)
			throw new Error(
				"Could not check GitHub for Desktop updates. Retry later.",
			);
		const batch: Release[] = await response.json();
		if (!Array.isArray(batch))
			throw new Error("Invalid desktop release response.");
		releases.push(...batch);
		if (batch.length < 100) break;
	}
	const selected = selectRelease(releases, current, platform);
	return selected
		? {
				version: selected.tag_name.slice(9),
				url: `${repo}/releases/download/${selected.tag_name}/`,
			}
		: undefined;
}
export function validateUpdate(info: UpdateInfo, expected: string) {
	if (
		info.version !== expected ||
		!versionPattern.test(info.version) ||
		!info.files?.length
	)
		throw new Error(
			"Update metadata does not match the selected Desktop release.",
		);
	const names = new Set([
		`PlinyCode-Desktop-Setup-${expected}-x64.exe`,
		`PlinyCode-Desktop-${expected}-x64.AppImage`,
		`PlinyCode-Desktop-${expected}-x64.deb`,
	]);
	for (const file of info.files) {
		if (!names.has(file.url) || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512))
			throw new Error("Invalid Desktop update file or checksum.");
	}
}

/** UI-independent state machine; the Electron host supplies shutdown and platform installation. */
export class DesktopUpdate {
	status: UpdateStatus;
	private busy = false;
	private timer?: ReturnType<typeof setInterval>;
	private first?: ReturnType<typeof setTimeout>;
	constructor(
		private transport: UpdateTransport | undefined,
		current: string,
		private discover: () => Promise<
			{ version: string; url: string } | undefined
		>,
		private changed: (state: UpdateStatus) => void,
		private hasWork: () => boolean,
		private prepareInstall: () => Promise<void>,
	) {
		this.status = {
			currentVersion: current,
			phase: transport ? "idle" : "unsupported",
		};
		if (!transport) return;
		transport.autoDownload = false;
		transport.autoInstallOnAppQuit = false;
		transport.allowDowngrade = false;
		transport.allowPrerelease = false;
		// Full downloads avoid extra blockmap requests and retain the same SHA-512 verification.
		transport.disableDifferentialDownload = true;
		transport.on("download-progress", (progress) =>
			this.publish({ percent: Math.min(100, Math.max(0, progress.percent)) }),
		);
		transport.on("error", () =>
			this.publish({
				phase: "error",
				message:
					"Update failed. Check your connection or installer permissions, then retry.",
			}),
		);
	}
	private publish(patch: Partial<UpdateStatus>) {
		this.status = { ...this.status, ...patch };
		this.changed(this.status);
	}
	configure(automatic: boolean) {
		clearTimeout(this.first);
		clearInterval(this.timer);
		if (!automatic || !this.transport) return;
		this.first = setTimeout(() => void this.check(), 30_000);
		this.timer = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
	}
	close() {
		clearTimeout(this.first);
		clearInterval(this.timer);
	}
	async check() {
		if (
			!this.transport ||
			this.busy ||
			["ready", "installing"].includes(this.status.phase)
		)
			return;
		this.busy = true;
		this.publish({
			phase: "checking",
			message: undefined,
			version: undefined,
			percent: undefined,
		});
		try {
			const release = await this.discover();
			if (!release) {
				this.publish({
					phase: "idle",
					message: "You have the latest Desktop version.",
				});
				return;
			}
			this.transport.setFeedURL({ provider: "generic", url: release.url });
			const result = await this.transport.checkForUpdates();
			if (
				!result ||
				!newer(result.updateInfo.version, this.status.currentVersion)
			)
				throw new Error("Invalid update version.");
			validateUpdate(result.updateInfo, release.version);
			this.publish({ phase: "available", version: release.version });
		} catch {
			this.publish({
				phase: "error",
				message:
					"Could not check for updates. Check your connection and retry.",
			});
		} finally {
			this.busy = false;
		}
	}
	async download() {
		if (!this.transport || this.busy || this.status.phase !== "available")
			return;
		this.busy = true;
		this.publish({ phase: "downloading", percent: 0, message: undefined });
		try {
			await this.transport.downloadUpdate();
			this.publish({ phase: "ready", percent: 100 });
		} catch {
			this.publish({
				phase: "error",
				message:
					"Download failed or its checksum did not match. Check again to retry.",
			});
		} finally {
			this.busy = false;
		}
	}
	async install() {
		if (!this.transport || this.busy || this.status.phase !== "ready") return;
		if (this.hasWork()) {
			this.publish({
				message:
					"Stop running tasks and commands, and wait for PR operations, before installing.",
			});
			return;
		}
		this.busy = true;
		this.publish({ phase: "installing", message: undefined });
		try {
			await this.prepareInstall();
			this.transport.quitAndInstall(false, true);
		} catch {
			this.publish({
				phase: "error",
				message: "Installation could not start. Check again to retry.",
			});
		} finally {
			this.busy = false;
		}
	}
}
