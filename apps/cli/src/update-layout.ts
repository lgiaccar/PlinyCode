import { randomUUID } from "node:crypto";
import {
	lstat,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

export const STATE_FILE = "update-state.json";
export const MANIFEST_FILE = "cli-package.json";
export interface UpdateState {
	current: string;
	previous?: string;
}
export interface PackageInfo {
	product: string;
	version: string;
	platform: string;
	arch: string;
	updateLayout: number;
}
export function validVersion(version: string): boolean {
	return (
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) &&
		version.split(".").every((n) => Number.isSafeInteger(Number(n)))
	);
}
export function compareVersions(a: string, b: string): number {
	const aa = a.split(".").map(Number),
		bb = b.split(".").map(Number);
	for (let i = 0; i < 3; i++) {
		if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1;
	}
	return 0;
}
export function validSlot(slot: unknown): slot is string {
	return (
		typeof slot === "string" &&
		(slot === "." ||
			/^versions\/[0-9]+\.[0-9]+\.[0-9]+-[a-f0-9-]{36}$/.test(slot))
	);
}
export async function readState(root: string): Promise<UpdateState> {
	let text: string;
	try {
		text = await readFile(join(root, STATE_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return { current: "." };
		throw error;
	}
	const state = JSON.parse(text);
	if (
		!validSlot(state.current) ||
		(state.previous !== undefined && !validSlot(state.previous))
	)
		throw new Error(
			"Invalid update state. Re-extract the CLI into a new directory.",
		);
	return state;
}
export async function slotPath(root: string, slot: string): Promise<string> {
	if (!validSlot(slot)) throw new Error("Invalid installation slot.");
	const base = await realpath(root);
	let path = base;
	for (const segment of slot === "." ? [] : slot.split("/")) {
		path = join(path, segment);
		const stat = await lstat(path);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error(
				"Update directories must be real directories, not links.",
			);
	}
	if (resolve(await realpath(path)) !== resolve(path))
		throw new Error("Unexpected installation path.");
	return path;
}
export async function packageInfo(directory: string): Promise<PackageInfo> {
	const info = JSON.parse(
		await readFile(join(directory, MANIFEST_FILE), "utf8"),
	);
	if (
		info.product !== "plinycode-cli" ||
		!validVersion(info.version) ||
		info.arch !== "x64" ||
		!["windows", "linux"].includes(info.platform) ||
		info.updateLayout !== 1
	)
		throw new Error(
			"This package does not support safe self-update. Download an updater-enabled release manually.",
		);
	return info;
}
export async function writeState(
	root: string,
	state: UpdateState,
): Promise<void> {
	const temporary = join(root, `.update-state-${randomUUID()}.tmp`);
	await writeFile(temporary, `${JSON.stringify(state)}\n`, { flag: "wx" });
	// Same-directory rename is the commit point: readers see the old or new state.
	try {
		await rename(temporary, join(root, STATE_FILE));
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}
