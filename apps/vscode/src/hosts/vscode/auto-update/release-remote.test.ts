import { afterEach, beforeEach, describe, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import packageJson from "../../../../package.json"
import type { ReleaseManifest } from "./release-folder"
import { DEFAULT_RELEASE_URL, downloadVsix, fetchRemoteManifest, githubManifest, resolveRemoteAsset } from "./release-remote"

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

	describe("downloadVsix", () => {
		it("downloads and verifies the vsix", async () => {
			const { fetchImpl, requested } = fakeFetch({ [release.vsix]: () => new Response(VSIX_BYTES) })

			const staged = await downloadVsix(DEFAULT_RELEASE_URL, release, staging, fetchImpl)

			expect(requested).to.deep.equal([release.vsix])
			expect(await fs.readFile(staged)).to.deep.equal(VSIX_BYTES)
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
