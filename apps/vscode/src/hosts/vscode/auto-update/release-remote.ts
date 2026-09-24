import fs from "node:fs/promises"
import path from "node:path"
import { parseManifest, type ReleaseManifest, verifyStagedVsix } from "./release-folder"

/**
 * GitHub Releases is the primary update source: it needs no login or sync, so
 * it also reaches Linux and Remote-SSH hosts. Each release carries the .vsix
 * and a latest.json whose `vsix` and `notes` are absolute URLs pinned to that
 * release's tag, so a newer release published mid-download cannot swap files.
 */

export const GITHUB_REPO = "lgiaccar/PlinyCode"

/** Always serves latest.json from the newest non-draft, non-prerelease release. */
export const DEFAULT_RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`

const MANIFEST_TIMEOUT_MS = 30_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

type Fetch = typeof globalThis.fetch

/** Tag used for a release, e.g. `release_0.1.3`. */
export function releaseTag(version: string): string {
	return `release_${version}`
}

/** latest.json of one specific release, e.g. a pre-release that /releases/latest never serves. */
export function releaseManifestUrl(version: string): string {
	return `https://github.com/${GITHUB_REPO}/releases/download/${releaseTag(version)}/latest.json`
}

/** Manifest attached to a GitHub release; its URLs point at that release only. */
export function githubManifest(version: string, sha256: string, releasedAt: string): ReleaseManifest {
	const tag = releaseTag(version)
	return {
		product: "plinycode",
		version,
		vsix: `https://github.com/${GITHUB_REPO}/releases/download/${tag}/PlinyCode-${version}.vsix`,
		sha256,
		notes: `https://github.com/${GITHUB_REPO}/releases/tag/${tag}`,
		releasedAt,
	}
}

/**
 * Resolves a manifest URL against the manifest's own URL. Only https URLs on
 * the manifest's origin are accepted, so a manifest cannot send the updater
 * to another host (GitHub's redirect to its asset CDN happens after this check).
 */
export function resolveRemoteAsset(manifestUrl: string, ref: string): string {
	const base = new URL(manifestUrl)
	const resolved = new URL(ref, base)
	if (resolved.protocol !== "https:" || resolved.origin !== base.origin) {
		throw new Error(`"${ref}" is not an https URL on ${base.origin}`)
	}
	return resolved.href
}

/** Returns the published manifest, or undefined when nothing is published there yet (404). */
export async function fetchRemoteManifest(manifestUrl: string, fetchImpl: Fetch): Promise<ReleaseManifest | undefined> {
	const response = await fetchImpl(manifestUrl, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
	})
	if (response.status === 404) {
		return undefined
	}
	if (!response.ok) {
		throw new Error(`${manifestUrl} returned HTTP ${response.status}`)
	}
	const manifest = parseManifest(await response.text())
	resolveRemoteAsset(manifestUrl, manifest.vsix)
	if (manifest.notes) {
		resolveRemoteAsset(manifestUrl, manifest.notes)
	}
	return manifest
}

/** Downloads the release's .vsix into `stagingDir` and verifies its checksum. */
export async function downloadVsix(
	manifestUrl: string,
	manifest: ReleaseManifest,
	stagingDir: string,
	fetchImpl: Fetch,
): Promise<string> {
	const url = resolveRemoteAsset(manifestUrl, manifest.vsix)
	const response = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
	if (!response.ok) {
		throw new Error(`${url} returned HTTP ${response.status}`)
	}
	await fs.mkdir(stagingDir, { recursive: true })
	const staged = path.join(stagingDir, `PlinyCode-${manifest.version}.vsix`)
	await fs.writeFile(staged, Buffer.from(await response.arrayBuffer()))
	return verifyStagedVsix(staged, manifest, stagingDir)
}
