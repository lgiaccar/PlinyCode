import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * PlinyCode is not on a marketplace, so it updates itself from GitHub Releases
 * (release-remote.ts) and, as a fallback, from a shared OneDrive/SharePoint
 * folder that each user syncs to disk. Nothing here talks to SharePoint:
 * OneDrive puts the files on disk and we only read them. See
 * docs/releasing.md for the layout and the publishing steps.
 */

/** Name of the shared release folder, as it appears once synced. */
export const RELEASE_FOLDER_NAME = "PlinyCodeRelease"

/** Manifest at the top of the release folder, pointing at the newest release. */
export const MANIFEST_FILE_NAME = "latest.json"

const PRODUCT_ID = "plinycode"

export interface ReleaseManifest {
	product: typeof PRODUCT_ID
	/** Semver of the newest release, e.g. "0.1.3". */
	version: string
	/** Path of the .vsix, relative to the release folder. */
	vsix: string
	/** Lowercase hex sha256 of the .vsix. */
	sha256: string
	/** Optional path of the release notes, relative to the release folder. */
	notes?: string
	releasedAt?: string
}

export interface ReleaseFolderSearch {
	/** Explicit folder from the `plinycode.updates.folder` setting; disables discovery. */
	override?: string
	homeDir: string
	env: NodeJS.ProcessEnv
	platform: NodeJS.Platform
}

/**
 * Directories OneDrive may sync into. "Add shortcut to My files" puts shared
 * folders in the user's OneDrive root; "Sync" puts them under a folder named
 * after the organisation (e.g. `~/Synopsys, Inc/<owner> - PlinyCodeRelease`).
 */
async function oneDriveRoots({ homeDir, env, platform }: ReleaseFolderSearch): Promise<string[]> {
	const roots = [env.OneDriveCommercial, env.OneDrive].filter((root): root is string => !!root)

	const scan = async (dir: string, matches: (name: string) => boolean) => {
		for (const name of await listDirectories(dir)) {
			if (matches(name)) {
				roots.push(path.join(dir, name))
			}
		}
	}
	await scan(homeDir, (name) => /^onedrive/i.test(name) || /synopsys/i.test(name))
	if (platform === "darwin") {
		await scan(path.join(homeDir, "Library", "CloudStorage"), (name) => /^onedrive/i.test(name))
	}

	return [...new Set(roots.map((root) => path.resolve(root)))]
}

/** Returns the first synced release folder that holds a manifest, if any. */
export async function findReleaseFolder(search: ReleaseFolderSearch): Promise<string | undefined> {
	if (search.override?.trim()) {
		const folder = path.resolve(search.override.trim())
		return (await isFile(path.join(folder, MANIFEST_FILE_NAME))) ? folder : undefined
	}

	for (const root of await oneDriveRoots(search)) {
		const candidates = [root, ...(await listDirectories(root)).map((name) => path.join(root, name))]
		for (const candidate of candidates) {
			if (
				path.basename(candidate).endsWith(RELEASE_FOLDER_NAME) &&
				(await isFile(path.join(candidate, MANIFEST_FILE_NAME)))
			) {
				return candidate
			}
		}
	}
	return undefined
}

export function parseManifest(text: string): ReleaseManifest {
	let raw: unknown
	try {
		raw = JSON.parse(text)
	} catch {
		throw new Error(`${MANIFEST_FILE_NAME} is not valid JSON`)
	}
	const manifest = raw as Partial<ReleaseManifest> | null
	if (!manifest || manifest.product !== PRODUCT_ID) {
		throw new Error(`${MANIFEST_FILE_NAME} is not a PlinyCode release manifest`)
	}
	if (typeof manifest.version !== "string" || !parseVersion(manifest.version)) {
		throw new Error(`${MANIFEST_FILE_NAME} has an invalid "version"`)
	}
	if (typeof manifest.vsix !== "string" || !manifest.vsix.endsWith(".vsix")) {
		throw new Error(`${MANIFEST_FILE_NAME} has an invalid "vsix" path`)
	}
	if (typeof manifest.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(manifest.sha256)) {
		throw new Error(`${MANIFEST_FILE_NAME} has an invalid "sha256"`)
	}
	return { ...manifest, sha256: manifest.sha256.toLowerCase() } as ReleaseManifest
}

export async function readManifest(folder: string): Promise<ReleaseManifest> {
	return parseManifest(await fs.readFile(path.join(folder, MANIFEST_FILE_NAME), "utf8"))
}

/** Resolves a manifest path, refusing anything that escapes the release folder. */
export function resolveInReleaseFolder(folder: string, relativePath: string): string {
	const root = path.resolve(folder)
	const resolved = path.resolve(root, relativePath)
	if (path.isAbsolute(relativePath) || relativePath.includes("://") || !resolved.startsWith(root + path.sep)) {
		throw new Error(`"${relativePath}" is outside the release folder`)
	}
	return resolved
}

/**
 * Copies the release's .vsix into `stagingDir` and verifies its checksum. The
 * copy is what gets installed, so a file OneDrive is still syncing can never be
 * installed half-written.
 */
export async function stageVsix(folder: string, manifest: ReleaseManifest, stagingDir: string): Promise<string> {
	const source = resolveInReleaseFolder(folder, manifest.vsix)
	await fs.mkdir(stagingDir, { recursive: true })
	const staged = path.join(stagingDir, `PlinyCode-${manifest.version}.vsix`)
	await fs.copyFile(source, staged)
	return verifyStagedVsix(staged, manifest, stagingDir)
}

/**
 * Checks a staged .vsix against the manifest's checksum, deleting it on a
 * mismatch, then removes staged copies of older releases.
 */
export async function verifyStagedVsix(staged: string, manifest: ReleaseManifest, stagingDir: string): Promise<string> {
	const actual = await sha256File(staged)
	if (actual !== manifest.sha256) {
		await fs.rm(staged, { force: true })
		throw new Error(
			`checksum mismatch for ${manifest.vsix} (expected ${manifest.sha256}, got ${actual}); the file may still be syncing or was not fully downloaded`,
		)
	}

	// Staged copies of older releases are no longer needed.
	for (const entry of await fs.readdir(stagingDir)) {
		if (entry.endsWith(".vsix") && path.join(stagingDir, entry) !== staged) {
			await fs.rm(path.join(stagingDir, entry), { force: true })
		}
	}
	return staged
}

export function sha256File(filePath: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = createHash("sha256")
		createReadStream(filePath)
			.on("data", (chunk) => hash.update(chunk))
			.on("error", reject)
			.on("end", () => resolve(hash.digest("hex")))
	})
}

function parseVersion(version: string): [number, number, number, string] | undefined {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(version.trim())
	return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? ""] : undefined
}

/** Semver-style comparison; a pre-release sorts before its release. Invalid versions sort first. */
export function compareVersions(a: string, b: string): number {
	const left = parseVersion(a)
	const right = parseVersion(b)
	if (!left || !right) {
		return left ? 1 : right ? -1 : 0
	}
	for (let i = 0; i < 3; i++) {
		if (left[i] !== right[i]) {
			return (left[i] as number) - (right[i] as number)
		}
	}
	if (left[3] === right[3]) {
		return 0
	}
	if (!left[3] || !right[3]) {
		return left[3] ? -1 : 1
	}
	return left[3].localeCompare(right[3], undefined, { numeric: true })
}

async function listDirectories(dir: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(dir, { withFileTypes: true })
		// OneDrive folders are reparse points on Windows, which Node reports as
		// links rather than directories; callers only use entries that hold a manifest.
		return entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name)
	} catch {
		return []
	}
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await fs.stat(filePath)).isFile()
	} catch {
		return false
	}
}
