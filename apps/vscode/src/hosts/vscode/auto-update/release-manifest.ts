import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"

/**
 * PlinyCode is not on a marketplace, so it updates itself from GitHub Releases
 * (release-remote.ts). Each release carries a latest.json manifest describing
 * its .vsix; this module parses it and checks downloads against it. See
 * docs/releasing.md for the publishing steps.
 */

/** Manifest attached to every release, describing its .vsix. */
export const MANIFEST_FILE_NAME = "latest.json"

const PRODUCT_ID = "plinycode"

export interface ReleaseManifest {
	product: typeof PRODUCT_ID
	/** Semver of the release, e.g. "0.1.3". */
	version: string
	/** URL of the .vsix, absolute or relative to the manifest's URL. */
	vsix: string
	/** Lowercase hex sha256 of the .vsix. */
	sha256: string
	/** Optional URL of the release notes, like `vsix`. */
	notes?: string
	releasedAt?: string
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

/**
 * Checks a staged .vsix against the manifest's checksum, deleting it on a
 * mismatch, then removes staged copies of older releases.
 */
export async function verifyStagedVsix(staged: string, manifest: ReleaseManifest, stagingDir: string): Promise<string> {
	const actual = await sha256File(staged)
	if (actual !== manifest.sha256) {
		await fs.rm(staged, { force: true })
		throw new Error(
			`checksum mismatch for ${manifest.vsix} (expected ${manifest.sha256}, got ${actual}); the file was not fully downloaded`,
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
