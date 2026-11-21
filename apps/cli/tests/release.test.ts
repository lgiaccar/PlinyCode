import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	archiveName,
	prepareRelease,
	publishRelease,
	validateReleaseContext,
} from "../scripts/release-assets";

test("release refuses mismatched tags, commits and unsafe versions", () => {
	const sha = "a".repeat(40);
	validateReleaseContext("0.1.0", "refs/tags/cli-v0.1.0", sha, sha);
	for (const ref of [
		"refs/heads/stage",
		"refs/tags/release_0.1.0",
		"refs/tags/cli-v0.2.0",
	])
		expect(() => validateReleaseContext("0.1.0", ref, sha, sha)).toThrow();
	expect(() =>
		validateReleaseContext(
			"0.1.0",
			"refs/tags/cli-v0.1.0",
			sha,
			"b".repeat(40),
		),
	).toThrow();
	expect(() => archiveName("../escape", "linux")).toThrow();
});
test("both archives must match checksums before release assets are prepared", async () => {
	const scratch = resolve(import.meta.dir, "../../../ai_output");
	await mkdir(scratch, { recursive: true });
	const folder = await mkdtemp(join(scratch, "cli-release-"));
	for (const platform of ["windows", "linux"] as const) {
		const name = archiveName("0.1.0", platform),
			bytes = `fixture-${platform}`;
		await writeFile(join(folder, name), bytes);
		await writeFile(
			join(folder, `${name}.sha256`),
			`${createHash("sha256").update(bytes).digest("hex")}  ${name}\n`,
		);
	}
	const files = await prepareRelease(folder, "0.1.0", "Install instructions");
	expect(files).toHaveLength(4);
	expect(
		(await readFile(join(folder, "SHA256SUMS"), "utf8")).trim().split("\n"),
	).toHaveLength(2);
	expect(await readFile(join(folder, "INSTALL.md"), "utf8")).toBe(
		"Install instructions",
	);
	await writeFile(join(folder, archiveName("0.1.0", "linux")), "tampered");
	await expect(prepareRelease(folder, "0.1.0", "instructions")).rejects.toThrow(
		"checksum mismatch",
	);
});
test("publish completes draft uploads first, preserves latest, and refuses overwrites", async () => {
	const calls: string[][] = [];
	const options = {
		repo: "owner/repo",
		version: "0.1.0",
		sha: "a".repeat(40),
		files: ["windows.zip", "linux.tar.gz", "SHA256SUMS", "INSTALL.md"],
		notes: "notes.md",
		readRelease: async (tag: string) =>
			tag === "latest" ? { draft: false, tag_name: "release_0.2.10" } : null,
		run: async (args: string[]) => {
			calls.push(args);
		},
	};
	await publishRelease(options);
	expect(calls).toHaveLength(2);
	expect(calls[0]).toContain("--draft");
	expect(calls[0]).toContain("INSTALL.md");
	expect(calls.every((args) => args.includes("--latest=false"))).toBe(true);
	expect(calls[1]).toContain("--draft=false");
	calls.length = 0;
	await expect(
		publishRelease({
			...options,
			readRelease: async () => ({ draft: false, tag_name: "cli-v0.1.0" }),
		}),
	).rejects.toThrow("already exists");
	expect(calls).toHaveLength(0);
	await expect(
		publishRelease({
			...options,
			run: async (args) => {
				calls.push(args);
				throw new Error("upload failed");
			},
		}),
	).rejects.toThrow("upload failed");
	expect(calls).toHaveLength(1);
	expect(calls[0]).toContain("--draft");
});

test("prerelease flags and unexpected latest changes are checked", async () => {
	const calls: string[][] = [];
	let reads = 0;
	await expect(
		publishRelease({
			repo: "owner/repo",
			version: "0.2.0-test.1",
			sha: "a".repeat(40),
			files: [],
			notes: "notes.md",
			readRelease: async (tag) =>
				tag === "latest"
					? {
							draft: false,
							tag_name: ++reads === 1 ? "release_0.2.10" : "unexpected",
						}
					: null,
			run: async (args) => {
				calls.push(args);
			},
		}),
	).rejects.toThrow("latest release changed");
	expect(calls[0]).toContain("--prerelease");
	expect(calls.every((args) => args.includes("--latest=false"))).toBe(true);
});
