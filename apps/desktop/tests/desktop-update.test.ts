import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
	DesktopUpdate,
	discoverRelease,
	newer,
	selectRelease,
	validateUpdate,
} from "../src/desktop-update";

const info = {
	version: "0.1.2",
	files: [
		{
			url: "PlinyCode-Desktop-Setup-0.1.2-x64.exe",
			sha512: "A".repeat(86) + "==",
		},
	],
};
test("release discovery uses the public Desktop channel without forwarding credentials", async () => {
	const result = await discoverRelease(
		"0.1.1",
		"win32",
		async (url, options) => {
			expect(url).toBe(
				"https://api.github.com/repos/lgiaccar/PlinyCode/releases?per_page=100&page=1",
			);
			expect(new Headers(options?.headers).has("Authorization")).toBe(false);
			return Response.json([
				{
					tag_name: "desktop-v0.1.2",
					draft: false,
					prerelease: false,
					assets: [{ name: "latest.yml" }],
				},
			]);
		},
	);
	expect(result).toEqual({
		version: "0.1.2",
		url: "https://github.com/lgiaccar/PlinyCode/releases/download/desktop-v0.1.2/",
	});
	await expect(
		discoverRelease(
			"0.1.1",
			"win32",
			async () => new Response("rate limited", { status: 403 }),
		),
	).rejects.toThrow();
});
class Transport extends EventEmitter {
	autoDownload = true;
	autoInstallOnAppQuit = true;
	allowDowngrade = true;
	allowPrerelease = true;
	disableDifferentialDownload = false;
	downloads = 0;
	installs = 0;
	failDownload = false;
	setFeedURL() {}
	async checkForUpdates() {
		return { updateInfo: info };
	}
	async downloadUpdate() {
		this.downloads++;
		if (this.failDownload) throw new Error("bad digest");
		return ["fixture.exe"];
	}
	quitAndInstall() {
		this.installs++;
	}
}
test("Desktop release discovery ignores editor, CLI, drafts and prereleases and sorts numerically", () => {
	const release = (tag: string, extra = {}) => ({
		tag_name: tag,
		draft: false,
		prerelease: false,
		assets: [{ name: "latest.yml" }],
		...extra,
	});
	const all = [
		release("release_9.9.9"),
		release("cli-v9.9.9"),
		release("desktop-v0.1.9"),
		release("desktop-v0.1.10"),
		release("desktop-v99.0.0", { draft: true }),
		release("desktop-v98.0.0", { prerelease: true }),
	];
	expect(selectRelease(all, "0.1.8", "win32")?.tag_name).toBe(
		"desktop-v0.1.10",
	);
	expect(selectRelease(all, "0.1.10", "win32")).toBeUndefined();
	expect(selectRelease(all, "0.1.8", "linux")).toBeUndefined();
	expect(newer("0.1.2-test.1", "0.1.1")).toBe(false);
});
test("metadata refuses mismatched versions, paths, hosts and malformed hashes", () => {
	validateUpdate(info, "0.1.2");
	expect(() => validateUpdate(info, "0.1.3")).toThrow();
	for (const url of [
		"../installer.exe",
		"https://other.example/installer.exe",
		"PlinyCode-Desktop-Setup-0.1.1-x64.exe",
	])
		expect(() =>
			validateUpdate({ ...info, files: [{ ...info.files[0], url }] }, "0.1.2"),
		).toThrow();
	expect(() =>
		validateUpdate(
			{ ...info, files: [{ ...info.files[0], sha512: "bad" }] },
			"0.1.2",
		),
	).toThrow();
});
test("updates require separate download and install choices, block active work, and retry checksum errors", async () => {
	const transport = new Transport();
	let working = true;
	let prepared = 0;
	const updater = new DesktopUpdate(
		transport,
		"0.1.1",
		async () => ({ version: "0.1.2", url: "https://github.com/fixture/" }),
		() => {},
		() => working,
		async () => {
			prepared++;
		},
	);
	expect(transport.autoDownload).toBe(false);
	expect(transport.autoInstallOnAppQuit).toBe(false);
	expect(transport.allowDowngrade).toBe(false);
	expect(transport.allowPrerelease).toBe(false);
	await updater.install();
	expect(transport.installs).toBe(0);
	await updater.check();
	expect(updater.status.phase).toBe("available");
	expect(transport.downloads).toBe(0);
	transport.failDownload = true;
	await updater.download();
	expect(updater.status.phase).toBe("error");
	transport.failDownload = false;
	await updater.check();
	await updater.download();
	expect(updater.status.phase).toBe("ready");
	await updater.install();
	expect(transport.installs).toBe(0);
	expect(prepared).toBe(0);
	working = false;
	await updater.install();
	expect(transport.installs).toBe(1);
	expect(prepared).toBe(1);
	await updater.install();
	expect(transport.installs).toBe(1);
	updater.close();
});
test("overlapping discovery is coalesced, offline checks recover and no release is a normal result", async () => {
	let release!: () => void;
	let calls = 0;
	const updater = new DesktopUpdate(
		new Transport(),
		"0.1.2",
		async () => {
			calls++;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return undefined;
		},
		() => {},
		() => false,
		async () => {},
	);
	const pending = updater.check();
	await updater.check();
	expect(calls).toBe(1);
	release();
	await pending;
	expect(updater.status.phase).toBe("idle");
	const offline = new DesktopUpdate(
		new Transport(),
		"0.1.1",
		async () => {
			throw new Error("offline");
		},
		() => {},
		() => false,
		async () => {},
	);
	await offline.check();
	expect(offline.status.phase).toBe("error");
});
