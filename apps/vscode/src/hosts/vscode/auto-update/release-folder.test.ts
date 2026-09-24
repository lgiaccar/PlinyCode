import { afterEach, beforeEach, describe, it } from "bun:test"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { expect } from "chai"
import {
	compareVersions,
	findReleaseFolder,
	parseManifest,
	type ReleaseManifest,
	resolveInReleaseFolder,
	stageVsix,
} from "./release-folder"

const VSIX_BYTES = Buffer.from("not really a vsix")
const VSIX_SHA256 = createHash("sha256").update(VSIX_BYTES).digest("hex")

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
	return { product: "plinycode", version: "0.1.3", vsix: "0.1.3/PlinyCode-0.1.3.vsix", sha256: VSIX_SHA256, ...overrides }
}

async function writeRelease(folder: string, release = manifest()): Promise<void> {
	await fs.mkdir(path.join(folder, path.dirname(release.vsix)), { recursive: true })
	await fs.writeFile(path.join(folder, release.vsix), VSIX_BYTES)
	await fs.writeFile(path.join(folder, "latest.json"), JSON.stringify(release))
}

describe("release-folder", () => {
	let home: string

	beforeEach(async () => {
		home = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-update-"))
	})

	afterEach(async () => {
		await fs.rm(home, { recursive: true, force: true })
	})

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

	describe("findReleaseFolder", () => {
		const search = (extra: { override?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}) => ({
			homeDir: home,
			env: {},
			platform: "win32" as NodeJS.Platform,
			...extra,
		})

		it("finds a shortcut in the OneDrive root under the home folder", async () => {
			const folder = path.join(home, "OneDrive - Synopsys, Inc", "PlinyCodeRelease")
			await writeRelease(folder)
			expect(await findReleaseFolder(search())).to.equal(folder)
		})

		it("finds a folder synced under the organisation folder", async () => {
			const folder = path.join(home, "Synopsys, Inc", "Luigi Giaccari - PlinyCodeRelease")
			await writeRelease(folder)
			expect(await findReleaseFolder(search())).to.equal(folder)
		})

		it("finds the OneDrive root from the OneDriveCommercial variable", async () => {
			const root = path.join(home, "elsewhere", "Work OneDrive")
			await writeRelease(path.join(root, "PlinyCodeRelease"))
			expect(await findReleaseFolder(search({ env: { OneDriveCommercial: root } }))).to.equal(
				path.join(root, "PlinyCodeRelease"),
			)
		})

		it("finds the macOS CloudStorage location", async () => {
			const folder = path.join(home, "Library", "CloudStorage", "OneDrive-SynopsysInc", "PlinyCodeRelease")
			await writeRelease(folder)
			expect(await findReleaseFolder(search({ platform: "darwin" }))).to.equal(folder)
		})

		it("ignores a release folder without a manifest", async () => {
			await fs.mkdir(path.join(home, "OneDrive - Synopsys, Inc", "PlinyCodeRelease", "0.1.2"), { recursive: true })
			expect(await findReleaseFolder(search())).to.equal(undefined)
		})

		it("uses only the configured folder when one is set", async () => {
			await writeRelease(path.join(home, "OneDrive - Synopsys, Inc", "PlinyCodeRelease"))
			const custom = path.join(home, "custom")
			expect(await findReleaseFolder(search({ override: custom }))).to.equal(undefined)
			await writeRelease(custom)
			expect(await findReleaseFolder(search({ override: custom }))).to.equal(custom)
		})
	})

	describe("resolveInReleaseFolder", () => {
		it("refuses paths that escape the release folder", () => {
			expect(() => resolveInReleaseFolder(home, "../evil.vsix")).to.throw(/outside/)
			expect(() => resolveInReleaseFolder(home, path.resolve(home, "..", "evil.vsix"))).to.throw(/outside/)
			expect(resolveInReleaseFolder(home, "0.1.3/a.vsix")).to.equal(path.join(home, "0.1.3", "a.vsix"))
		})
	})

	describe("stageVsix", () => {
		it("copies a verified vsix and removes older staged copies", async () => {
			const folder = path.join(home, "PlinyCodeRelease")
			const staging = path.join(home, "staging")
			await writeRelease(folder)
			await fs.mkdir(staging, { recursive: true })
			await fs.writeFile(path.join(staging, "PlinyCode-0.1.2.vsix"), "old")

			const staged = await stageVsix(folder, manifest(), staging)

			expect(staged).to.equal(path.join(staging, "PlinyCode-0.1.3.vsix"))
			expect(await fs.readdir(staging)).to.deep.equal(["PlinyCode-0.1.3.vsix"])
		})

		it("rejects a vsix whose checksum does not match and leaves nothing staged", async () => {
			const folder = path.join(home, "PlinyCodeRelease")
			const staging = path.join(home, "staging")
			await writeRelease(folder)

			let error: unknown
			try {
				await stageVsix(folder, manifest({ sha256: "0".repeat(64) }), staging)
			} catch (caught) {
				error = caught
			}

			expect(String(error)).to.match(/checksum mismatch/)
			expect(await fs.readdir(staging)).to.deep.equal([])
		})
	})
})
