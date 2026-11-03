import { afterEach, describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { zipSync } from "fflate"
import { assertReleaseServices, checkReleasePackage } from "../../../scripts/check-release-package"

const version = "0.2.8-test.4"
const services = ["cline.PipelineService", "cline.AgentMonitorService"]
const bytes = (text: string) => Buffer.from(text)
const files = (backend: string) => ({
	"extension/package.json": bytes(JSON.stringify({ version })),
	"extension/dist/extension.js": bytes(backend),
	"extension/webview-ui/build/assets/index.js": bytes('client.serviceName="cline.AgentMonitorService"'),
})
const validBackend = 'const handlers={"cline.PipelineService":runs,"cline.AgentMonitorService":agents};'
const temporary: string[] = []
afterEach(async () => {
	for (const dir of temporary.splice(0)) await fs.rm(dir, { recursive: true, force: true })
})

describe("release RPC compatibility", () => {
	it("accepts matching production backend and webview bundles", () => {
		expect(() => assertReleaseServices(files(validBackend), version, services)).not.toThrow()
	})
	it("rejects a current webview packaged with an older backend", () => {
		expect(() => assertReleaseServices(files('const handlers={"cline.PipelineService":runs};'), version, services)).toThrow(
			"cline.AgentMonitorService",
		)
	})
	it("requires a registration, not just a service name in an error message", () => {
		expect(() => assertReleaseServices(files('const msg="cline.AgentMonitorService";'), version, services)).toThrow(
			"missing RPC services",
		)
	})
	it("also checks declared services not referenced by the webview", () => {
		expect(() => assertReleaseServices(files(validBackend), version, [...services, "cline.NewService"])).toThrow(
			"cline.NewService",
		)
	})
	it("rejects missing files and a differently versioned package", () => {
		expect(() => assertReleaseServices({}, version, services)).toThrow("missing extension/package.json")
		expect(() => assertReleaseServices(files(validBackend), "0.2.8-test.5", services)).toThrow("does not match")
	})
	it("reads the actual VSIX bytes against source declarations before publication", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "plinycode-release-test-"))
		temporary.push(root)
		await fs.mkdir(path.join(root, "proto/cline"), { recursive: true })
		await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version }))
		await fs.writeFile(
			path.join(root, "proto/cline/agents.proto"),
			"service PipelineService {}\nservice AgentMonitorService {}\n",
		)
		const vsix = path.join(root, "test.vsix")
		await fs.writeFile(vsix, zipSync(files(validBackend)))
		await checkReleasePackage(vsix, root)
		await fs.writeFile(vsix, zipSync(files('const handlers={"cline.PipelineService":runs};')))
		await expect(checkReleasePackage(vsix, root)).rejects.toThrow("cline.AgentMonitorService")
	})
})
