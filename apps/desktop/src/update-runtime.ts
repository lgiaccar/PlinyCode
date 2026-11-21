import { app } from "electron";
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
	let discover = () => discoverRelease(app.getVersion(), process.platform);
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
		// CI owns the next launch so it can verify the installed version and old history.
		if (__PLINY_UPDATE_TEST_BUILD__) transport.autoRunAppAfterInstall = false;
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
