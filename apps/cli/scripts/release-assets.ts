import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export function archiveName(version: string, platform: "windows" | "linux") {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
		throw new Error("Invalid CLI version.");
	return `PlinyCode-CLI-${version}-${platform}-x64.${platform === "windows" ? "zip" : "tar.gz"}`;
}

export function validateReleaseContext(
	version: string,
	ref: string,
	sha: string,
	head: string,
) {
	archiveName(version, "linux");
	if (
		ref !== `refs/tags/cli-v${version}` ||
		!/^[a-f0-9]{40}$/.test(sha) ||
		sha !== head
	)
		throw new Error(
			"Publish only the matching CLI version tag at the checked-out commit.",
		);
}

export async function prepareRelease(
	directory: string,
	version: string,
	installation: string,
) {
	const names = [
		archiveName(version, "windows"),
		archiveName(version, "linux"),
	];
	const lines: string[] = [];
	for (const name of names) {
		const bytes = await readFile(join(directory, name));
		if (!bytes.length) throw new Error(`Empty archive: ${name}`);
		const hash = createHash("sha256").update(bytes).digest("hex");
		const line = `${hash}  ${name}`;
		if (
			(await readFile(join(directory, `${name}.sha256`), "utf8")).trim() !==
			line
		)
			throw new Error(`Archive checksum mismatch: ${name}`);
		lines.push(line);
	}
	await writeFile(join(directory, "SHA256SUMS"), `${lines.join("\n")}\n`);
	await writeFile(join(directory, "INSTALL.md"), installation);
	return [...names, "SHA256SUMS", "INSTALL.md"].map((name) =>
		join(directory, name),
	);
}

type Release = { draft: boolean; tag_name: string };
export async function publishRelease(options: {
	repo: string;
	version: string;
	sha: string;
	files: string[];
	notes: string;
	readRelease: (tag: string) => Promise<Release | null>;
	run: (args: string[]) => Promise<void>;
}) {
	const { repo, version, sha, files, notes, readRelease, run } = options;
	const tag = `cli-v${version}`;
	if (await readRelease(tag))
		throw new Error("CLI release already exists; refusing to replace it.");
	const previousLatest = (await readRelease("latest"))?.tag_name;
	await run([
		"release",
		"create",
		tag,
		...files,
		"--repo",
		repo,
		"--verify-tag",
		"--target",
		sha,
		"--title",
		`PlinyCode CLI ${version}`,
		"--notes-file",
		notes,
		"--draft",
		"--latest=false",
		...(version.includes("-") ? ["--prerelease"] : []),
	]);
	await run([
		"release",
		"edit",
		tag,
		"--repo",
		repo,
		"--draft=false",
		"--latest=false",
	]);
	if ((await readRelease("latest"))?.tag_name !== previousLatest)
		throw new Error(
			"The repository's latest release changed during CLI publication. Inspect the extension release before proceeding.",
		);
}
