#!/usr/bin/env bun

/**
 * Packages a PlinyCode release and publishes it where the extension's
 * auto-updater looks: a GitHub release (primary) and the shared
 * PlinyCodeRelease OneDrive folder (fallback). See docs/releasing.md.
 *
 * Usage (from apps/vscode):
 *   bun scripts/release.ts package              # build dist/release/<version>/PlinyCode-<version>.vsix
 *   bun scripts/release.ts publish --dry-run    # run every check and show what publish would do
 *   bun scripts/release.ts publish              # GitHub release, then the OneDrive folder
 *
 * Options for publish:
 *   --prerelease      publish a GitHub pre-release only: not served by /releases/latest and never
 *                     copied to the folder; testers point plinycode.updates.url at its latest.json
 *   --skip-github     publish to the folder only
 *   --skip-folder     publish to GitHub only
 *   --folder <path>   release folder (default: $PLINYCODE_RELEASE_FOLDER, else found in OneDrive)
 *   --force           publish a version that is not newer than the published one, or whose tag is not HEAD
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	compareVersions,
	findReleaseFolder,
	MANIFEST_FILE_NAME,
	RELEASE_FOLDER_NAME,
	type ReleaseManifest,
	readManifest,
	sha256File,
} from "../src/hosts/vscode/auto-update/release-folder"
import {
	DEFAULT_RELEASE_URL,
	fetchRemoteManifest,
	GITHUB_REPO,
	githubManifest,
	releaseManifestUrl,
	releaseTag,
} from "../src/hosts/vscode/auto-update/release-remote"
import { restore, swapIn } from "./marketplace-readme.mjs"

const projectRoot = path.resolve(import.meta.dir, "..")
const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as { version: string }
const vsixName = `PlinyCode-${version}.vsix`
const stagingDir = path.join(projectRoot, "dist", "release", version)
const tag = releaseTag(version)
const prerelease = process.argv.includes("--prerelease")

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
	const index = args.indexOf(name)
	return index >= 0 ? args[index + 1] : undefined
}

function fail(message: string): never {
	console.error(`release: ${message}`)
	process.exit(1)
}

async function exists(filePath: string): Promise<boolean> {
	return fs.stat(filePath).then(
		() => true,
		() => false,
	)
}

/** Runs a command; output is captured unless `inherit` is set. */
function run(command: string[], inherit = false): { ok: boolean; stdout: string; stderr: string } {
	const result = Bun.spawnSync(command, {
		cwd: projectRoot,
		stdio: inherit ? ["inherit", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
	})
	return {
		ok: result.exitCode === 0,
		stdout: result.stdout?.toString().trim() ?? "",
		stderr: result.stderr?.toString().trim() ?? "",
	}
}

async function packageRelease(): Promise<void> {
	await fs.mkdir(stagingDir, { recursive: true })
	const out = path.join(stagingDir, vsixName)

	// vsce bakes README.md into the .vsix; ship the extension-focused one.
	const swap = swapIn()
	try {
		// --no-dependencies: the extension is esbuild-bundled, and walking node_modules
		// would follow the @plinycode/* workspace links into the whole monorepo.
		// vsce runs `vscode:prepublish` (bun run package) before packaging.
		const vsce = run(
			["bun", "x", "vsce", "package", "--no-dependencies", "--allow-package-secrets", "sendgrid", "--out", out],
			true,
		)
		if (!vsce.ok) {
			fail("vsce package failed")
		}
	} finally {
		if (!swap.skipped) {
			restore()
		}
	}

	console.log(`\nPackaged ${path.relative(projectRoot, out)}`)
	console.log(`sha256 ${await sha256File(out)}`)
	console.log(`Next: write ${path.relative(projectRoot, path.join(stagingDir, "README.md"))}, then run publish.`)
}

async function resolveReleaseFolder(): Promise<string | undefined> {
	const explicit = option("--folder") ?? process.env.PLINYCODE_RELEASE_FOLDER
	if (explicit) {
		if (!(await exists(explicit))) {
			fail(`release folder ${explicit} does not exist`)
		}
		return path.resolve(explicit)
	}
	const found = await findReleaseFolder({ homeDir: os.homedir(), env: process.env, platform: process.platform })
	if (found) {
		return found
	}
	// First publish: the folder exists but has no latest.json yet.
	for (const root of [process.env.OneDriveCommercial, process.env.OneDrive]) {
		if (root && (await exists(path.join(root, RELEASE_FOLDER_NAME)))) {
			return path.join(root, RELEASE_FOLDER_NAME)
		}
	}
	return undefined
}

function requireNewer(target: string, published: string | undefined): void {
	if (published && compareVersions(version, published) <= 0 && !flag("--force")) {
		fail(`${version} is not newer than ${published} on ${target}; bump the version or pass --force`)
	}
}

/** Checks everything GitHub publishing needs, before anything is published anywhere. */
async function checkGithub(): Promise<string | undefined> {
	if (!run(["gh", "auth", "status"]).ok) {
		fail("the GitHub CLI is not logged in; run `gh auth login`")
	}
	if (!run(["git", "ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`]).ok) {
		fail(`tag ${tag} is not on origin; commit the release, then \`git tag ${tag} && git push origin ${tag}\``)
	}
	const tagCommit = run(["git", "rev-parse", `${tag}^{commit}`]).stdout
	const head = run(["git", "rev-parse", "HEAD"]).stdout
	if (tagCommit !== head && !flag("--force")) {
		fail(`tag ${tag} is ${tagCommit.slice(0, 7)} but HEAD is ${head.slice(0, 7)}; package from the tagged commit`)
	}
	if (run(["gh", "release", "view", tag, "--repo", GITHUB_REPO]).ok) {
		fail(`GitHub release ${tag} already exists; delete it on GitHub first if you mean to replace it`)
	}
	return (await fetchRemoteManifest(DEFAULT_RELEASE_URL, fetch))?.version
}

async function publishGithub(manifest: ReleaseManifest, notes: string): Promise<void> {
	const manifestFile = path.join(stagingDir, MANIFEST_FILE_NAME)
	await fs.writeFile(manifestFile, `${JSON.stringify(manifest, null, "\t")}\n`)

	// A draft is invisible to /releases/latest, so users only see the release
	// once both assets are uploaded and it is published in the second step.
	// A pre-release is never served by /releases/latest, so it only reaches
	// editors whose plinycode.updates.url points at its own latest.json.
	const vsix = path.join(stagingDir, vsixName)
	const create = ["gh", "release", "create", tag, "--repo", GITHUB_REPO, "--verify-tag", "--draft"]
	if (prerelease) {
		create.push("--prerelease")
	}
	if (!run([...create, "--title", `PlinyCode ${version}`, "--notes-file", notes, vsix, manifestFile], true).ok) {
		fail("gh release create failed; nothing was published")
	}
	const edit = ["gh", "release", "edit", tag, "--repo", GITHUB_REPO, "--draft=false", `--latest=${!prerelease}`]
	if (!run(edit, true).ok) {
		fail(`the draft release ${tag} is uploaded but could not be published; publish it on GitHub`)
	}

	const url = prerelease ? releaseManifestUrl(version) : DEFAULT_RELEASE_URL
	for (let attempt = 0; attempt < 5; attempt++) {
		const live = await fetchRemoteManifest(url, fetch).catch(() => undefined)
		if (live?.version === version) {
			console.log(`GitHub: ${url} now serves ${version}`)
			break
		}
		if (attempt === 4) {
			console.warn(`GitHub: ${url} does not serve ${version} yet; check the release page`)
		}
		await Bun.sleep(3000)
	}
	if (prerelease) {
		const latest = await fetchRemoteManifest(DEFAULT_RELEASE_URL, fetch).catch(() => undefined)
		if (latest?.version === version) {
			console.warn(`GitHub: WARNING: ${DEFAULT_RELEASE_URL} serves the pre-release; mark it as a pre-release on GitHub`)
		} else {
			console.log(`GitHub: ${DEFAULT_RELEASE_URL} still serves ${latest?.version ?? "no release"}, so users are unaffected`)
		}
		console.log(`To test it, set plinycode.updates.url to ${url}`)
	}
}

async function publishFolder(folder: string, manifest: ReleaseManifest, notes: string): Promise<void> {
	// The .vsix and notes go first and latest.json last, so users are only
	// pointed at a release whose files are already in the folder.
	const targetDir = path.join(folder, version)
	await fs.mkdir(targetDir, { recursive: true })
	await fs.copyFile(path.join(stagingDir, vsixName), path.join(targetDir, vsixName))
	await fs.copyFile(notes, path.join(targetDir, "README.md"))
	if ((await sha256File(path.join(targetDir, vsixName))) !== manifest.sha256) {
		fail("the copied .vsix does not match its checksum; latest.json was not updated")
	}
	const manifestPath = path.join(folder, MANIFEST_FILE_NAME)
	await fs.writeFile(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, "\t")}\n`)
	await fs.rename(`${manifestPath}.tmp`, manifestPath)
	console.log(`Folder: published ${version} to ${folder}; OneDrive will upload it`)
}

async function publishRelease(): Promise<void> {
	const dryRun = flag("--dry-run")
	const vsix = path.join(stagingDir, vsixName)
	const notes = path.join(stagingDir, "README.md")
	if (!(await exists(vsix))) {
		fail(`${path.relative(projectRoot, vsix)} is missing; run \`bun run release:package\` first`)
	}
	if (!(await exists(notes))) {
		fail(`${path.relative(projectRoot, notes)} is missing; write the release notes first`)
	}
	const sha256 = await sha256File(vsix)
	const releasedAt = new Date().toISOString().slice(0, 10)

	// Every check runs before anything is published.
	const github = !flag("--skip-github")
	if (prerelease && !github) {
		fail("--prerelease publishes to GitHub only; drop --skip-github")
	}
	if (github) {
		const published = await checkGithub()
		requireNewer(`GitHub (${GITHUB_REPO})`, published)
		console.log(`GitHub: ${GITHUB_REPO} release ${tag} (published now: ${published ?? "none"})`)
	}
	// The folder has no pre-release channel: everyone who syncs it would install it.
	const skipFolder = flag("--skip-folder") || prerelease
	const folder = skipFolder ? undefined : await resolveReleaseFolder()
	if (folder) {
		const published = (await exists(path.join(folder, MANIFEST_FILE_NAME))) ? (await readManifest(folder)).version : undefined
		requireNewer(folder, published)
		console.log(`Folder: ${folder} (published now: ${published ?? "none"})`)
	} else if (!skipFolder) {
		console.warn(`Folder: ${RELEASE_FOLDER_NAME} not found, skipping it (pass --folder to include it)`)
	}
	if (!github && !folder) {
		fail("nothing to publish to")
	}
	console.log(`Release: ${version}  sha256 ${sha256}`)

	if (dryRun) {
		console.log("\nDry run: all checks passed; nothing was published.")
		return
	}
	if (github) {
		await publishGithub(githubManifest(version, sha256, releasedAt), notes)
	}
	if (folder) {
		await publishFolder(
			folder,
			{ product: "plinycode", version, vsix: `${version}/${vsixName}`, sha256, notes: `${version}/README.md`, releasedAt },
			notes,
		)
	}
	console.log(
		prerelease
			? `\nPublished pre-release ${version}. Only editors whose plinycode.updates.url points at it will install it.`
			: `\nPublished ${version}. Users get it at their next update check.`,
	)
}

switch (args[0]) {
	case "package":
		await packageRelease()
		break
	case "publish":
		await publishRelease()
		break
	default:
		fail(
			"usage: bun scripts/release.ts <package | publish [--dry-run] [--prerelease] [--skip-github] [--skip-folder] [--folder <path>] [--force]>",
		)
}
