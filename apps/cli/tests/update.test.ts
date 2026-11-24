import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { acquireUpdateLock } from "../src/update";
import {
	extractPackage,
	safeArchivePath,
	verifyChecksum,
} from "../src/update-archive";
import { assetURL, type Release, selectRelease } from "../src/update-feed";
import {
	compareVersions,
	readState,
	validVersion,
	writeState,
} from "../src/update-layout";

const roots: string[] = [];
async function temporary() {
	const root = await mkdtemp(join(tmpdir(), "pliny-update-"));
	roots.push(root);
	return root;
}
afterEach(async () => {
	for (const root of roots.splice(0))
		await rm(root, { recursive: true, force: true });
});
const release = (tag: string, extra: Partial<Release> = {}): Release => ({
	tag_name: tag,
	draft: false,
	prerelease: false,
	assets: [],
	...extra,
});
describe("CLI update safety", () => {
	test("selects stable CLI releases by semantic version, not release dates or editor latest", () => {
		expect(
			selectRelease([
				release("release_9.9.9"),
				release("desktop-v9.9.9"),
				release("cli-v0.1.9"),
				release("cli-v0.1.10"),
				release("cli-v99.0.0", { draft: true }),
				release("cli-v3.0.0", { prerelease: true }),
				release("cli-v4.0.0-test.1"),
			])?.tag_name,
		).toBe("cli-v0.1.10");
		expect(selectRelease([release("cli-v0.1.2")], "0.1.1")).toBeUndefined();
	});
	test("rejects invalid versions and compares patch/minor/major correctly", () => {
		for (const version of [
			"01.1.2",
			"../../x",
			"1.2",
			"v1.2.3",
			"1.2.3-beta",
			"9007199254740993.0.0",
		])
			expect(validVersion(version)).toBe(false);
		expect(validVersion("0.1.2")).toBe(true);
		expect(compareVersions("0.2.0", "0.1.99")).toBe(1);
		expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
	});
	test("release assets must belong to the selected public CLI tag", () => {
		for (const url of [
			"http://github.com/x",
			"https://example.com/a",
			"https://github.com/other/repo/releases/download/cli-v0.1.2/SHA256SUMS",
		])
			expect(() =>
				assetURL(
					release("cli-v0.1.2", {
						assets: [{ name: "SHA256SUMS", browser_download_url: url }],
					}),
					"SHA256SUMS",
				),
			).toThrow();
		expect(() => assetURL(release("cli-v0.1.2"), "SHA256SUMS")).toThrow();
	});
	test("rejects corrupt, missing and duplicate checksums", () => {
		const bytes = Buffer.from("ok"),
			hash = createHash("sha256").update(bytes).digest("hex"),
			line = `${hash}  pkg.zip`;
		verifyChecksum(bytes, line, "pkg.zip");
		for (const manifest of [
			"",
			`${line}\n${line}`,
			`${"0".repeat(64)}  pkg.zip`,
		])
			expect(() => verifyChecksum(bytes, manifest, "pkg.zip")).toThrow();
	});
	test("rejects traversal, absolute, device and ambiguous archive paths", () => {
		for (const path of [
			"../x",
			"/tmp/x",
			"C:/x",
			"a/../b",
			"a\\b",
			"a/nul.txt",
			"a/name.",
			"a/name ",
			"a/./b",
			"a/x:y",
		])
			expect(safeArchivePath(path)).toBe(false);
		expect(
			safeArchivePath("plinycode-windows-x64/examples/skills/review/SKILL.md"),
		).toBe(true);
	});
	test("rejects ZIP traversal before writing outside staging", async () => {
		const root = await temporary(),
			stage = join(root, "stage");
		await mkdir(stage);
		await expect(
			extractPackage(
				Buffer.from(zipSync({ "../escaped": Buffer.from("bad") })),
				stage,
				"windows",
			),
		).rejects.toThrow();
		expect(await Bun.file(join(root, "escaped")).exists()).toBe(false);
	});
	test("rejects malformed archive and wrong top-level folder", async () => {
		const root = await temporary();
		await expect(
			extractPackage(Buffer.from("invalid"), root, "windows"),
		).rejects.toThrow();
		await expect(
			extractPackage(
				Buffer.from(zipSync({ "wrong/file": Buffer.from("bad") })),
				root,
				"windows",
			),
		).rejects.toThrow();
	});
	test("switches state atomically and rejects unsafe state", async () => {
		const root = await temporary();
		expect(await readState(root)).toEqual({ current: "." });
		const state = {
			current: "versions/0.1.2-12345678-1234-1234-1234-123456789abc",
			previous: ".",
		};
		await writeState(root, state);
		expect(await readState(root)).toEqual(state);
		await writeFile(
			join(root, "update-state.json"),
			JSON.stringify({ current: "../outside" }),
		);
		await expect(readState(root)).rejects.toThrow();
	});
	test("update lock excludes another updater and releases afterwards", async () => {
		const root = await temporary();
		const unlock = await acquireUpdateLock(root);
		await expect(acquireUpdateLock(root)).rejects.toThrow("Another CLI update");
		await unlock();
		await (await acquireUpdateLock(root))();
	});
	test("recovers lock left by a crashed process", async () => {
		const root = await temporary();
		await mkdir(join(root, ".update-lock"));
		await writeFile(
			join(root, ".update-lock/owner.json"),
			JSON.stringify({ pid: 2147483647 }),
		);
		const unlock = await acquireUpdateLock(root);
		expect(
			JSON.parse(await readFile(join(root, ".update-lock/owner.json"), "utf8"))
				.pid,
		).toBe(process.pid);
		await unlock();
	});
	test("reports unwritable installation without changing state", async () => {
		const root = await temporary();
		await writeFile(join(root, "not-a-directory"), "sentinel");
		await expect(
			acquireUpdateLock(join(root, "not-a-directory")),
		).rejects.toThrow("Cannot write");
		expect(await readFile(join(root, "not-a-directory"), "utf8")).toBe(
			"sentinel",
		);
	});
});
