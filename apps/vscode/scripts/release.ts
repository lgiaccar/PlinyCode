#!/usr/bin/env bun

/**
 * Packages a PlinyCode release and publishes it to the shared PlinyCodeRelease
 * OneDrive folder that the extension's auto-updater reads. See docs/releasing.md.
 *
 * Usage (from apps/vscode):
 *   bun scripts/release.ts package                  # build dist/release/<version>/PlinyCode-<version>.vsix
 *   bun scripts/release.ts publish --dry-run        # show what publish would do
 *   bun scripts/release.ts publish                  # copy .vsix + README.md, then write latest.json
 *
 * Options for publish:
 *   --folder <path>   release folder (default: $PLINYCODE_RELEASE_FOLDER, else found in OneDrive)
 *   --force           republish a version that is not newer than latest.json
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
import { restore, swapIn } from "./marketplace-readme.mjs"

const projectRoot = path.resolve(import.meta.dir, "..")
const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8")) as { version: string }
const vsixName = `PlinyCode-${version}.vsix`
const stagingDir = path.join(projectRoot, "dist", "release", version)

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

async function packageRelease(): Promise<void> {
	await fs.mkdir(stagingDir, { recursive: true })
	const out = path.join(stagingDir, vsixName)

	// vsce bakes README.md into the .vsix; ship the extension-focused one.
	const swap = swapIn()
	try {
		// --no-dependencies: the extension is esbuild-bundled, and walking node_modules
		// would follow the @plinycode/* workspace links into the whole monorepo.
		// vsce runs `vscode:prepublish` (bun run package) before packaging.
		const vsce = Bun.spawnSync(
			["bun", "x", "vsce", "package", "--no-dependencies", "--allow-package-secrets", "sendgrid", "--out", out],
			{ cwd: projectRoot, stdio: ["inherit", "inherit", "inherit"] },
		)
		if (vsce.exitCode !== 0) {
			fail(`vsce package exited with code ${vsce.exitCode}`)
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

async function resolveReleaseFolder(): Promise<string> {
	const explicit = option("--folder") ?? process.env.PLINYCODE_RELEASE_FOLDER
	if (explicit) {
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
	fail(`could not find the ${RELEASE_FOLDER_NAME} folder; pass --folder or set PLINYCODE_RELEASE_FOLDER`)
}

async function publishRelease(): Promise<void> {
	const dryRun = flag("--dry-run")
	const vsix = path.join(stagingDir, vsixName)
	const notes = path.join(stagingDir, "README.md")
	if (!(await exists(vsix))) {
		fail(`${path.relative(projectRoot, vsix)} is missing; run \`bun scripts/release.ts package\` first`)
	}
	if (!(await exists(notes))) {
		fail(`${path.relative(projectRoot, notes)} is missing; write the release notes first`)
	}

	const folder = await resolveReleaseFolder()
	if (!(await exists(folder))) {
		fail(`release folder ${folder} does not exist`)
	}

	const manifestPath = path.join(folder, MANIFEST_FILE_NAME)
	const current = (await exists(manifestPath)) ? await readManifest(folder) : undefined
	if (current && compareVersions(version, current.version) <= 0 && !flag("--force")) {
		fail(`${version} is not newer than the published ${current.version}; bump the version or pass --force`)
	}

	const sha256 = await sha256File(vsix)
	const manifest: ReleaseManifest = {
		product: "plinycode",
		version,
		vsix: `${version}/${vsixName}`,
		sha256,
		notes: `${version}/README.md`,
		releasedAt: new Date().toISOString().slice(0, 10),
	}
	const targetDir = path.join(folder, version)

	console.log(`Release folder: ${folder}`)
	console.log(`Published now:  ${current?.version ?? "(no latest.json yet)"}`)
	console.log(`Publishing:     ${version}  sha256 ${sha256}`)
	console.log(`  ${path.join(targetDir, vsixName)}`)
	console.log(`  ${path.join(targetDir, "README.md")}`)
	console.log(`  ${manifestPath}\n${JSON.stringify(manifest, null, "\t")}`)
	if (dryRun) {
		console.log("\nDry run: nothing was copied.")
		return
	}

	// The .vsix and notes go first and latest.json last, so users are only
	// pointed at a release whose files are already in the folder.
	await fs.mkdir(targetDir, { recursive: true })
	await fs.copyFile(vsix, path.join(targetDir, vsixName))
	await fs.copyFile(notes, path.join(targetDir, "README.md"))
	if ((await sha256File(path.join(targetDir, vsixName))) !== sha256) {
		fail("the copied .vsix does not match its checksum; latest.json was not updated")
	}
	const tempManifest = `${manifestPath}.tmp`
	await fs.writeFile(tempManifest, `${JSON.stringify(manifest, null, "\t")}\n`)
	await fs.rename(tempManifest, manifestPath)

	console.log(`\nPublished ${version}. OneDrive will upload it; users get it at their next update check.`)
}

switch (args[0]) {
	case "package":
		await packageRelease()
		break
	case "publish":
		await publishRelease()
		break
	default:
		fail("usage: bun scripts/release.ts <package | publish [--dry-run] [--folder <path>] [--force]>")
}
