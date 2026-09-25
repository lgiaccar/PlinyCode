import { afterEach, beforeEach, describe, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import packageJson from "../../../../package.json"
import type { ReleaseManifest } from "./release-manifest"
import {
	DEFAULT_RELEASE_URL,
	downloadVsix,
	fetchRemoteManifest,
	findNewestRelease,
	githubManifest,
	RELEASES_FEED_URL,
	releaseManifestUrl,
	resolveRemoteAsset,
	versionsInReleaseFeed,
} from "./release-remote"

const VSIX_BYTES = Buffer.from("not really a vsix")
const VSIX_SHA256 = createHash("sha256").update(VSIX_BYTES).digest("hex")

/** Serves `routes` by exact URL and records every request. */
function fakeFetch(routes: Record<string, () => Response>) {
	const requested: string[] = []
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input)
		requested.push(url)
		return routes[url]?.() ?? new Response("not found", { status: 404 })
	}) as typeof globalThis.fetch
	return { fetchImpl, requested }
}

describe("release-remote", () => {
	let staging: string
	const release = githubManifest("0.1.3", VSIX_SHA256, "2026-09-24")

	beforeEach(async () => {
		staging = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-remote-"))
	})

	afterEach(async () => {
		await fs.rm(staging, { recursive: true, force: true })
	})

	it("keeps the package.json default URL in step with the code", () => {
		expect(packageJson.contributes.configuration.properties["plinycode.updates.url"].default).to.equal(DEFAULT_RELEASE_URL)
	})

	it("pins the vsix and notes to the release tag", () => {
		expect(release.vsix).to.equal(
			"https://github.com/lgiaccar/PlinyCode/releases/download/release_0.1.3/PlinyCode-0.1.3.vsix",
		)
		expect(release.notes).to.equal("https://github.com/lgiaccar/PlinyCode/releases/tag/release_0.1.3")
	})

	describe("resolveRemoteAsset", () => {
		it("accepts relative and same-origin https URLs", () => {
			expect(resolveRemoteAsset(DEFAULT_RELEASE_URL, "PlinyCode-0.1.3.vsix")).to.equal(
				"https://github.com/lgiaccar/PlinyCode/releases/latest/download/PlinyCode-0.1.3.vsix",
			)
			expect(resolveRemoteAsset(DEFAULT_RELEASE_URL, release.vsix)).to.equal(release.vsix)
		})

		it("refuses other hosts and plain http", () => {
			expect(() => resolveRemoteAsset(DEFAULT_RELEASE_URL, "https://evil.example/PlinyCode.vsix")).to.throw(
				/not an https URL/,
			)
			expect(() => resolveRemoteAsset(DEFAULT_RELEASE_URL, "http://github.com/x.vsix")).to.throw(/not an https URL/)
		})
	})

	describe("fetchRemoteManifest", () => {
		it("returns the published manifest", async () => {
			const { fetchImpl } = fakeFetch({ [DEFAULT_RELEASE_URL]: () => Response.json(release) })
			expect(await fetchRemoteManifest(DEFAULT_RELEASE_URL, fetchImpl)).to.deep.equal(release)
		})

		it("returns undefined when nothing is published yet", async () => {
			const { fetchImpl } = fakeFetch({})
			expect(await fetchRemoteManifest(DEFAULT_RELEASE_URL, fetchImpl)).to.equal(undefined)
		})

		it("rejects server errors and manifests pointing at another host", async () => {
			const failing = fakeFetch({ [DEFAULT_RELEASE_URL]: () => new Response("oops", { status: 503 }) })
			const foreign: ReleaseManifest = { ...release, vsix: "https://evil.example/PlinyCode-0.1.3.vsix" }
			const hijacked = fakeFetch({ [DEFAULT_RELEASE_URL]: () => Response.json(foreign) })

			const errors: string[] = []
			for (const { fetchImpl } of [failing, hijacked]) {
				await fetchRemoteManifest(DEFAULT_RELEASE_URL, fetchImpl).catch((error) => errors.push(String(error)))
			}

			expect(errors).to.have.length(2)
			expect(errors[0]).to.match(/HTTP 503/)
			expect(errors[1]).to.match(/not an https URL/)
		})
	})

	describe("findNewestRelease", () => {
		/** A releases.atom entry, shaped like GitHub's. */
		const entry = (tag: string) =>
			`<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link rel="alternate" type="text/html" href="https://github.com/lgiaccar/PlinyCode/releases/tag/${tag}"/><title>${tag}</title></entry>`
		const feed = (...tags: string[]) => `<?xml version="1.0" encoding="UTF-8"?><feed>${tags.map(entry).join("")}</feed>`
		/** Serves the feed plus a latest.json for each of `published`. */
		const github = (tags: string[], published: string[]) => {
			const routes: Record<string, () => Response> = { [RELEASES_FEED_URL]: () => new Response(feed(...tags)) }
			for (const version of published) {
				routes[releaseManifestUrl(version)] = () => Response.json(githubManifest(version, VSIX_SHA256, "2026-09-25"))
			}
			return fakeFetch(routes)
		}

		it("lists the feed's versions newest first, ignoring other tags", () => {
			const tags = ["release_0.1.4-test.2", "release_0.1.3", "nightly", "release_0.1.4-test.10", "release_0.1.4-test.2"]
			expect(versionsInReleaseFeed(feed(...tags))).to.deep.equal(["0.1.4-test.10", "0.1.4-test.2", "0.1.3"])
		})

		it("returns the newest release, pre-releases included", async () => {
			const { fetchImpl } = github(["release_0.1.3", "release_0.1.4-test.1"], ["0.1.3", "0.1.4-test.1"])
			const found = await findNewestRelease(fetchImpl)
			expect(found?.url).to.equal(releaseManifestUrl("0.1.4-test.1"))
			expect(found?.manifest.version).to.equal("0.1.4-test.1")
		})

		it("prefers an official release over its own pre-releases", async () => {
			const { fetchImpl } = github(["release_0.1.4", "release_0.1.4-test.3"], ["0.1.4", "0.1.4-test.3"])
			expect((await findNewestRelease(fetchImpl))?.manifest.version).to.equal("0.1.4")
		})

		it("skips tags without a published latest.json", async () => {
			const { fetchImpl, requested } = github(["release_0.1.5-test.1", "release_0.1.3"], ["0.1.3"])
			expect((await findNewestRelease(fetchImpl))?.manifest.version).to.equal("0.1.3")
			expect(requested).to.include(releaseManifestUrl("0.1.5-test.1"))
		})

		it("returns undefined when nothing is published", async () => {
			expect(await findNewestRelease(github([], []).fetchImpl)).to.equal(undefined)
		})

		it("rejects feed errors", async () => {
			const { fetchImpl } = fakeFetch({ [RELEASES_FEED_URL]: () => new Response("busy", { status: 429 }) })
			let error: unknown
			await findNewestRelease(fetchImpl).catch((caught) => {
				error = caught
			})
			expect(String(error)).to.match(/HTTP 429/)
		})
	})

	describe("downloadVsix", () => {
		it("downloads and verifies the vsix, removing older staged copies", async () => {
			const { fetchImpl, requested } = fakeFetch({ [release.vsix]: () => new Response(VSIX_BYTES) })
			await fs.writeFile(path.join(staging, "PlinyCode-0.1.2.vsix"), "old")

			const staged = await downloadVsix(DEFAULT_RELEASE_URL, release, staging, fetchImpl)

			expect(requested).to.deep.equal([release.vsix])
			expect(await fs.readFile(staged)).to.deep.equal(VSIX_BYTES)
			expect(await fs.readdir(staging)).to.deep.equal(["PlinyCode-0.1.3.vsix"])
		})

		it("discards a download whose checksum does not match", async () => {
			const { fetchImpl } = fakeFetch({ [release.vsix]: () => new Response("truncated") })

			let error: unknown
			await downloadVsix(DEFAULT_RELEASE_URL, release, staging, fetchImpl).catch((caught) => {
				error = caught
			})

			expect(String(error)).to.match(/checksum mismatch/)
			expect(await fs.readdir(staging)).to.deep.equal([])
		})
	})
})
