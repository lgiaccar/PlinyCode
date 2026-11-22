import { app, net } from "electron";
import electronUpdater from "electron-updater";
import {
	DesktopUpdate,
	discoverRelease,
	type UpdateStatus,
} from "./desktop-update";

declare const __PLINY_UPDATE_TEST_BUILD__: boolean;
declare const __PLINY_DESKTOP_RELEASE_VERSION__: string;
export function createDesktopUpdate(
	changed: (state: UpdateStatus) => void,
	hasWork: () => boolean,
	prepare: () => Promise<void>,
) {
	// Use Chromium's network stack so discovery and installer downloads share OS proxy settings.
	let discover = () =>
		discoverRelease(app.getVersion(), process.platform, (url, options) =>
			net.fetch(url, options),
		);
	// Only the separately compiled, unpublished CI baseline accepts a loopback fixture.
	if (__PLINY_UPDATE_TEST_BUILD__) {
		const url = new URL(process.env.PLINY_DESKTOP_UPDATE_FIXTURE ?? "");
		if (url.protocol !== "http:" || url.hostname !== "127.0.0.1")
			throw new Error("Expected loopback update fixture.");
		discover = async () => ({
			version: __PLINY_DESKTOP_RELEASE_VERSION__,
			url: url.href,
		});
	}
	const transport =
		app.isPackaged &&
		process.arch === "x64" &&
		["win32", "linux"].includes(process.platform)
			? electronUpdater.autoUpdater
			: undefined;
	if (transport) {
		transport.logger = null;
	}
	return new DesktopUpdate(
		transport,
		app.getVersion(),
		discover,
		changed,
		hasWork,
		prepare,
	);
}
