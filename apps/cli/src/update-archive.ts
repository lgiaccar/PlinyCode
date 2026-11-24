import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { t, x } from "tar";
import { MANIFEST_FILE, packageInfo } from "./update-layout";

const MAX_UNPACKED = 512 * 1024 * 1024;
export function safeArchivePath(path: string): boolean {
	return (
		path.length > 0 &&
		!path.includes("\\") &&
		!path.includes(":") &&
		[...path].every((c) => c.charCodeAt(0) >= 32) &&
		path
			.split("/")
			.every(
				(p) =>
					p !== ".." &&
					p !== "." &&
					!/[ .]$/.test(p) &&
					!/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(p),
			) &&
		!path.startsWith("/")
	);
}
export function verifyChecksum(
	bytes: Uint8Array,
	manifest: string,
	name: string,
): void {
	const hashes = manifest
		.split(/\r?\n/)
		.map((line) => /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line))
		.filter((m) => m?.[2] === name);
	if (
		hashes.length !== 1 ||
		hashes[0]?.[1].toLowerCase() !==
			createHash("sha256").update(bytes).digest("hex")
	)
		throw new Error(`Checksum verification failed: ${name}`);
}
export async function extractPackage(
	archive: Buffer,
	staging: string,
	platform: string,
): Promise<string> {
	const prefix = `plinycode-${platform}-x64`;
	let total = 0,
		count = 0;
	const names = new Set<string>();
	const validate = (path: string, size: number) => {
		const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
		if (
			!safeArchivePath(normalized) ||
			(normalized !== prefix && !normalized.startsWith(`${prefix}/`)) ||
			names.has(normalized.toLowerCase())
		)
			throw new Error("Unsafe or duplicate archive path.");
		names.add(normalized.toLowerCase());
		total += size;
		count++;
		if (total > MAX_UNPACKED || count > 5000 || size < 0)
			throw new Error("Archive exceeds extraction limits.");
	};
	if (platform === "windows") {
		const files = unzipSync(archive, {
			filter: (file) => {
				validate(file.name, file.originalSize);
				return true;
			},
		});
		for (const [path, bytes] of Object.entries(files)) {
			const destination = join(staging, path);
			if (path.endsWith("/")) await mkdir(destination, { recursive: true });
			else {
				await mkdir(dirname(destination), { recursive: true });
				await writeFile(destination, bytes, { flag: "wx" });
			}
		}
	} else {
		const file = join(staging, "download.tar.gz");
		await writeFile(file, archive, { flag: "wx" });
		t({
			file,
			sync: true,
			strict: true,
			onReadEntry: (entry) => {
				if (!["File", "Directory"].includes(entry.type))
					throw new Error("Archive links and special files are not allowed.");
				validate(entry.path, entry.size);
			},
		});
		x({
			file,
			cwd: staging,
			sync: true,
			strict: true,
			noChmod: true,
			noMtime: true,
			preserveOwner: false,
		});
	}
	const directory = join(staging, prefix);
	await verifyPackage(directory, platform, true);
	await chmod(
		join(directory, "runtime", platform === "windows" ? "bun.exe" : "bun"),
		0o755,
	);
	if (platform === "linux") await chmod(join(directory, "plinycode"), 0o755);
	return directory;
}
export async function verifyPackage(
	directory: string,
	platform: string,
	strict = false,
): Promise<void> {
	const info = await packageInfo(directory);
	if (info.platform !== platform)
		throw new Error("Update package platform mismatch.");
	const manifest = await readFile(join(directory, "SHA256SUMS"), "utf8");
	const required = [
		MANIFEST_FILE,
		"plinycode.js",
		"launcher.js",
		`runtime/${platform === "windows" ? "bun.exe" : "bun"}`,
		platform === "windows" ? "plinycode.cmd" : "plinycode",
	];
	const seen = new Set<string>();
	for (const line of manifest.trim().split(/\r?\n/)) {
		const match = /^([a-fA-F0-9]{64}) {2}(.+)$/.exec(line);
		if (
			!match ||
			!safeArchivePath(match[2]) ||
			match[2].endsWith("/") ||
			seen.has(match[2].toLowerCase())
		)
			throw new Error("Invalid package checksum manifest.");
		const relative = match[2];
		let path = directory;
		for (const segment of relative.split("/")) {
			path = join(path, segment);
			if ((await lstat(path)).isSymbolicLink())
				throw new Error("Package links are not allowed.");
		}
		verifyChecksum(await readFile(path), manifest, relative);
		seen.add(relative.toLowerCase());
	}
	for (const path of required)
		if (!seen.has(path.toLowerCase()))
			throw new Error(`Incomplete update package: ${path}`);
	if (strict) {
		async function visit(folder: string, relative = ""): Promise<void> {
			for (const name of await readdir(folder)) {
				const path = join(folder, name),
					rel = relative ? `${relative}/${name}` : name;
				const stat = await lstat(path);
				if (stat.isSymbolicLink())
					throw new Error("Package links are not allowed.");
				if (stat.isDirectory()) await visit(path, rel);
				else if (
					!stat.isFile() ||
					(rel !== "SHA256SUMS" && !seen.has(rel.toLowerCase()))
				)
					throw new Error("Unverified package file.");
			}
		}
		await visit(directory);
	}
}
