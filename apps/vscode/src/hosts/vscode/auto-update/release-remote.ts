import fs from "node:fs/promises"
import path from "node:path"
import { compareVersions, parseManifest, type ReleaseManifest, verifyStagedVsix } from "./release-manifest"

/**
 * GitHub Releases is the primary update source: it needs no login or sync, so
 * it also reaches Linux and Remote-SSH hosts. Each release carries the .vsix
 * and a latest.json whose `vsix` and `notes` are absolute URLs pinned to that
 * release's tag, so a newer release published mid-download cannot swap files.
 */

export const GITHUB_REPO = "lgiaccar/PlinyCode"

/** Always serves latest.json from the newest non-draft, non-prerelease release. */
export const DEFAULT_RELEASE_URL = `https://github.com/${GITHUB_REPO}/releases/latest/download/latest.json`

/**
 * Atom feed of the newest releases and tags, pre-releases included (drafts
 * never appear). Read only when `plinycode.updates.prerelease` is on, since
 * /releases/latest never serves a pre-release. The feed is used instead of
 * api.github.com because the API allows 60 anonymous requests an hour per IP,
 * which a whole office behind one proxy address exhausts.
 */
export const RELEASES_FEED_URL = `https://github.com/${GITHUB_REPO}/releases.atom`

/** How many of the feed's newest versions to try before giving up. */
const MAX_FEED_VERSIONS = 5

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

/** Versions named by the feed's `release_<version>` tags, newest first. */
export function versionsInReleaseFeed(feed: string): string[] {
	const versions = new Set<string>()
	for (const match of feed.matchAll(/\/releases\/tag\/release_([^"'<>\s]+)/g)) {
		const version = decodeURIComponent(match[1])
		// compareVersions sorts invalid versions first, so this drops tags that aren't versions.
		if (compareVersions(version, "") > 0) {
			versions.add(version)
		}
	}
	return [...versions].sort((a, b) => compareVersions(b, a))
}

/**
 * Finds the newest published release, pre-releases included, and returns its
 * manifest with the latest.json URL it came from, or undefined when there is
 * none. The feed also lists bare tags, so versions whose latest.json is
 * missing (404) are skipped; deleting that asset therefore takes a release off
 * the pre-release channel. The URL is on github.com, like DEFAULT_RELEASE_URL,
 * so the usual same-origin checks apply to the manifest.
 */
export async function findNewestRelease(fetchImpl: Fetch): Promise<{ url: string; manifest: ReleaseManifest } | undefined> {
	const response = await fetchImpl(RELEASES_FEED_URL, {
		headers: { Accept: "application/atom+xml" },
		signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
	})
	if (!response.ok) {
		throw new Error(`${RELEASES_FEED_URL} returned HTTP ${response.status}`)
	}
	for (const version of versionsInReleaseFeed(await response.text()).slice(0, MAX_FEED_VERSIONS)) {
		const url = releaseManifestUrl(version)
		const manifest = await fetchRemoteManifest(url, fetchImpl)
		if (manifest) {
			return { url, manifest }
		}
	}
	return undefined
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
