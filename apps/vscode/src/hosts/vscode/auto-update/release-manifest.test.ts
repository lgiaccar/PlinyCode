import { describe, it } from "bun:test"
import { createHash } from "node:crypto"
import { expect } from "chai"
import { compareVersions, parseManifest, type ReleaseManifest } from "./release-manifest"

const VSIX_SHA256 = createHash("sha256").update("not really a vsix").digest("hex")

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
	return { product: "plinycode", version: "0.1.3", vsix: "0.1.3/PlinyCode-0.1.3.vsix", sha256: VSIX_SHA256, ...overrides }
}

describe("release-manifest", () => {
	describe("compareVersions", () => {
		it("orders numerically, not lexically", () => {
			expect(compareVersions("0.1.10", "0.1.9")).to.be.greaterThan(0)
			expect(compareVersions("0.2.0", "0.10.0")).to.be.lessThan(0)
			expect(compareVersions("v1.0.0", "1.0.0")).to.equal(0)
		})

		it("sorts a pre-release before its release", () => {
			expect(compareVersions("0.2.0-rc.1", "0.2.0")).to.be.lessThan(0)
			expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.2")).to.be.greaterThan(0)
		})

		it("never treats an invalid version as newer", () => {
			expect(compareVersions("garbage", "0.1.0")).to.be.lessThan(0)
		})
	})

	describe("parseManifest", () => {
		it("accepts a valid manifest and lowercases the checksum", () => {
			const parsed = parseManifest(JSON.stringify(manifest({ sha256: VSIX_SHA256.toUpperCase() })))
			expect(parsed.version).to.equal("0.1.3")
			expect(parsed.sha256).to.equal(VSIX_SHA256)
		})

		it("rejects files that are not PlinyCode manifests", () => {
			expect(() => parseManifest("{")).to.throw(/not valid JSON/)
			expect(() => parseManifest(JSON.stringify({ ...manifest(), product: "other" }))).to.throw(/not a PlinyCode/)
			expect(() => parseManifest(JSON.stringify(manifest({ version: "latest" })))).to.throw(/version/)
			expect(() => parseManifest(JSON.stringify(manifest({ sha256: "abc" })))).to.throw(/sha256/)
			expect(() => parseManifest(JSON.stringify(manifest({ vsix: "0.1.3/readme.md" })))).to.throw(/vsix/)
		})
	})
})
