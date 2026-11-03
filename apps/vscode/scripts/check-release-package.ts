import fs from "node:fs/promises"
import path from "node:path"
import { unzipSync } from "fflate"

const manifestPath = "extension/package.json"
const backendPath = "extension/dist/extension.js"
const webviewPath = "extension/webview-ui/build/assets/index.js"
const bundlePaths = [manifestPath, backendPath, webviewPath]

/** Check shipped bytes, not generated sources that may be newer than the bundles. */
export function assertReleaseServices(files: Record<string, Uint8Array>, version: string, services: string[]): void {
	const read = (name: string) => {
		if (!files[name]) throw new Error(`Release package is missing ${name}. Run the full production build.`)
		return Buffer.from(files[name]).toString("utf8")
	}
	const manifest = JSON.parse(read(manifestPath))
	if (manifest.version !== version) throw new Error(`Release package version ${manifest.version} does not match ${version}.`)
	const backend = read(backendPath)
	const webview = read(webviewPath)
	const registered = new Set([...backend.matchAll(/["'](cline\.\w+Service)["']\s*:/g)].map((match) => match[1]))
	const requested = new Set([...webview.matchAll(/["'](cline\.\w+Service)["']/g)].map((match) => match[1]))
	const missing = [...new Set([...services, ...requested])].filter((service) => !registered.has(service))
	if (missing.length) {
		throw new Error(
			`Release backend is missing RPC services: ${missing.join(", ")}. Rebuild the extension and webview together; do not reuse dist/extension.js.`,
		)
	}
}

async function releaseContract(projectRoot: string) {
	const { version } = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"))
	const protoDir = path.join(projectRoot, "proto/cline")
	const services: string[] = []
	for (const file of await fs.readdir(protoDir)) {
		if (!file.endsWith(".proto")) continue
		const proto = await fs.readFile(path.join(protoDir, file), "utf8")
		for (const match of proto.matchAll(/^\s*service\s+(\w+)\s*\{/gm)) services.push(`cline.${match[1]}`)
	}
	if (!services.length) throw new Error("No RPC service declarations found; cannot validate release.")
	return { version, services }
}

export async function checkReleasePackage(vsix: string, projectRoot: string): Promise<void> {
	const { version, services } = await releaseContract(projectRoot)
	const files = unzipSync(await fs.readFile(vsix), { filter: (entry) => bundlePaths.includes(entry.name) })
	assertReleaseServices(files, version, services)
	console.log(`Verified packaged backend registrations for ${services.length} RPC services (${version}).`)
}

async function checkBuild(projectRoot: string): Promise<void> {
	const { version, services } = await releaseContract(projectRoot)
	const files: Record<string, Uint8Array> = {}
	for (const name of bundlePaths) files[name] = await fs.readFile(path.join(projectRoot, name.replace(/^extension\//, "")))
	assertReleaseServices(files, version, services)
	console.log(`Verified backend/webview RPC compatibility for ${services.length} services (${version}).`)
}

if (import.meta.main) {
	const projectRoot = path.resolve(import.meta.dir, "..")
	if (process.argv[2] === "--bundles") await checkBuild(projectRoot)
	else if (process.argv[2]) await checkReleasePackage(path.resolve(process.argv[2]), projectRoot)
	else throw new Error("Usage: bun scripts/check-release-package.ts <package.vsix | --bundles>")
}
