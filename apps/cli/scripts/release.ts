import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	prepareRelease,
	publishRelease,
	validateReleaseContext,
} from "./release-assets";

const repoRoot = resolve(import.meta.dir, "../../..");
const { version } = JSON.parse(
	await readFile(join(repoRoot, "apps/cli/package.json"), "utf8"),
);
async function output(command: string[]) {
	const child = Bun.spawn(command, {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [text, errors, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`${command[0]} failed: ${errors}`);
	return text.trim();
}
const mode = process.argv[2];
if (!["--preflight", "--prepare", "--publish"].includes(mode))
	throw new Error(
		"Use --preflight, --prepare <artifact-directory>, or --publish <artifact-directory>.",
	);
if (mode !== "--prepare") {
	validateReleaseContext(
		version,
		process.env.GITHUB_REF ?? "",
		process.env.GITHUB_SHA ?? "",
		await output(["git", "rev-parse", "HEAD"]),
	);
}
if (mode === "--preflight") process.exit(0);
if (!process.argv[3]) throw new Error("An artifact directory is required.");
const directory = resolve(process.argv[3]);
const installation = (
	await readFile(join(repoRoot, "docs/cli-install.md"), "utf8")
)
	.replaceAll("0.1.0", version)
	.replaceAll(
		"(cli.md)",
		`(https://github.com/lgiaccar/PlinyCode/blob/cli-v${version}/docs/cli.md)`,
	);
const files = await prepareRelease(directory, version, installation);
if (mode === "--publish") {
	const repo = process.env.GITHUB_REPOSITORY;
	if (repo !== "lgiaccar/PlinyCode")
		throw new Error("Publishing is restricted to lgiaccar/PlinyCode.");
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	if (!token) throw new Error("GitHub authentication is required.");
	await publishRelease({
		repo,
		version,
		sha: process.env.GITHUB_SHA ?? "",
		files,
		notes: join(repoRoot, `apps/cli/releases/${version}.md`),
		readRelease: async (tag) => {
			const response = await fetch(
				`https://api.github.com/repos/${repo}/releases/${tag === "latest" ? "latest" : `tags/${tag}`}`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
					},
				},
			);
			if (response.status === 404) return null;
			if (!response.ok)
				throw new Error(
					`GitHub release lookup failed: HTTP ${response.status}`,
				);
			return response.json();
		},
		run: async (args) => {
			await output(["gh", ...args]);
		},
	});
}
console.log(files.join("\n"));
