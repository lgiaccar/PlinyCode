#!/usr/bin/env node
// Standalone collector: Node 22+, no packages, network API, or Azure DevOps token needed.
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, realpath, rename, statfs, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

const { values } = parseArgs({
	options: {
		"agent-root": { type: "string" },
		output: { type: "string" },
		"collection-url": { type: "string" },
		interval: { type: "string", default: "60" },
		once: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
	},
})
if (values.help) {
	console.log(
		"PlinyCode disk collector: node collect-disk.mjs --agent-root <agent install folder> --output <shared folder> [--once] [--interval 60] [--collection-url <matching collection URL>]",
	)
	process.exit(0)
}
if (!values["agent-root"] || !values.output) throw new Error("Both --agent-root and --output are required. Use --help.")
const interval = Number(values.interval)
if (!Number.isInteger(interval) || interval < 15 || interval > 300) throw new Error("Interval must be 15–300 seconds.")
const root = path.resolve(values["agent-root"])
const output = path.resolve(values.output)

async function collect() {
	// .agent contains identity/settings; never read .credentials or enumerate environment variables.
	const settings = JSON.parse((await readFile(path.join(root, ".agent"), "utf8")).replace(/^\uFEFF/, ""))
	if (
		!Number.isSafeInteger(settings.agentId) ||
		settings.agentId <= 0 ||
		!Number.isSafeInteger(settings.poolId) ||
		settings.poolId <= 0
	) {
		throw new Error("The .agent file must identify a pool agent with positive agentId and poolId.")
	}
	if (typeof settings.workFolder !== "string" || !settings.workFolder.trim())
		throw new Error("The .agent file has no workFolder.")
	const url = new URL(values["collection-url"] || settings.serverUrl)
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
		throw new Error("Use an HTTPS collection URL without credentials, query, or fragment.")
	const collection = createHash("sha256").update(url.href.replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 24)
	const workPath = await realpath(path.resolve(root, settings.workFolder))
	const fs = await statfs(workPath, { bigint: true })
	const freeBytes = Number(fs.bavail * fs.bsize)
	const totalBytes = Number(fs.blocks * fs.bsize)
	if (
		!Number.isSafeInteger(freeBytes) ||
		!Number.isSafeInteger(totalBytes) ||
		totalBytes <= 0 ||
		freeBytes < 0 ||
		freeBytes > totalBytes
	) {
		throw new Error("The working filesystem returned invalid capacity values.")
	}
	const reading = {
		schemaVersion: 1,
		collection,
		poolId: settings.poolId,
		agentId: settings.agentId,
		path: workPath,
		freeBytes,
		totalBytes,
		collectedAt: Date.now(),
	}
	await mkdir(output, { recursive: true })
	const destination = path.join(output, `${collection}-${settings.poolId}-${settings.agentId}.json`)
	const temporary = `${destination}.${randomUUID()}.tmp`
	try {
		await writeFile(temporary, `${JSON.stringify(reading)}\n`, { flag: "wx", mode: 0o640 })
		await rename(temporary, destination)
	} finally {
		await unlink(temporary).catch(() => {})
	}
	console.log(
		`${new Date(reading.collectedAt).toISOString()} Pool ${settings.poolId}, agent ${settings.agentId}: ${(freeBytes / 1073741824).toFixed(1)} GiB free (${((100 * freeBytes) / totalBytes).toFixed(1)}%).`,
	)
}

// A stuck network mount must not leave a one-shot scheduled task running forever.
async function boundedCollect() {
	const watchdog = setTimeout(() => {
		console.error("PlinyCode disk collection timed out; check working/shared-folder access.")
		process.exit(1)
	}, 30_000)
	try {
		await collect()
	} finally {
		clearTimeout(watchdog)
	}
}

do {
	try {
		await boundedCollect()
	} catch (error) {
		console.error(`PlinyCode disk collector: ${error instanceof Error ? error.message : "collection failed"}`)
		if (values.once) process.exit(1)
	}
	if (!values.once) await new Promise((resolve) => setTimeout(resolve, interval * 1000))
} while (!values.once)
