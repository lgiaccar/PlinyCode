import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { type AgentDiskReading, type AgentMonitorConfig, matchesAgentCapability } from "@/shared/agent-monitor"
import { type AgentPoolSnapshot, agentQueueTarget } from "./agent-source"

export function diskCollectionKey(collectionUrl: string): string {
	return createHash("sha256").update(new URL(collectionUrl).href.replace(/\/+$/, "").toLowerCase()).digest("hex").slice(0, 24)
}

// A separate process keeps an unavailable network share out of the extension's filesystem thread pool.
// Fixed program; paths and filenames arrive as data on stdin, never interpolated into code.
const READ_DISKS = `
const fs = require('node:fs/promises');
const path = require('node:path');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', async () => {
  const { folder, files } = JSON.parse(input);
  const result = {};
  let index = 0, finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify(result), () => process.exit(0));
  };
  const timer = setTimeout(finish, 3000);
  const worker = async () => {
    while (!finished && index < files.length) {
      const name = files[index++];
      let handle;
      try {
        handle = await fs.open(path.join(folder, name), 'r');
        if (!(await handle.stat()).isFile()) throw new Error('Not a file');
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) throw new Error('Too large');
        result[name] = buffer.toString('utf8', 0, bytesRead);
      } catch { /* Missing, invalid and inaccessible files remain unavailable. */ }
      finally { if (handle) await handle.close().catch(() => {}); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  clearTimeout(timer);
  finish();
});
`

function readDiskFiles(folder: string, files: string[]): Promise<Record<string, string>> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			["-e", READ_DISKS],
			{
				env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
				windowsHide: true,
				timeout: 5000,
				maxBuffer: 8 * 1024 * 1024,
			},
			(error, stdout) => {
				if (error) {
					reject(new Error("Disk reader unavailable"))
					return
				}
				try {
					resolve(JSON.parse(stdout))
				} catch {
					reject(new Error("Invalid disk reader response"))
				}
			},
		)
		child.stdin?.on("error", () => {})
		child.stdin?.end(JSON.stringify({ folder, files }))
	})
}

export function parseAgentDisk(
	text: string,
	collection: string,
	poolId: number,
	agentId: number,
	now = Date.now(),
): AgentDiskReading {
	const data = JSON.parse(text)
	if (
		!data ||
		data.schemaVersion !== 1 ||
		data.collection !== collection ||
		data.poolId !== poolId ||
		data.agentId !== agentId ||
		typeof data.path !== "string" ||
		!data.path.trim() ||
		data.path.length > 1024 ||
		/[\u0000-\u001f]/.test(data.path) ||
		!Number.isSafeInteger(data.freeBytes) ||
		!Number.isSafeInteger(data.totalBytes) ||
		data.totalBytes <= 0 ||
		data.freeBytes < 0 ||
		data.freeBytes > data.totalBytes ||
		!Number.isSafeInteger(data.collectedAt) ||
		data.collectedAt <= 0 ||
		data.collectedAt > now + 60_000
	) {
		throw new Error("Invalid disk reading")
	}
	return { path: data.path, freeBytes: data.freeBytes, totalBytes: data.totalBytes, collectedAt: data.collectedAt }
}

/** Disk failures never replace the Azure DevOps status result with a connection error. */
export class AgentDiskReader {
	constructor(private readonly read = readDiskFiles) {}

	async enrich(pool: AgentPoolSnapshot, config: AgentMonitorConfig): Promise<AgentPoolSnapshot> {
		if (!config.diskMetricsFolder) return pool
		const collection = diskCollectionKey(agentQueueTarget(config.queueUrl).collectionUrl)
		const agents = pool.agents.map((agent) => ({ ...agent }))
		const targets = agents.filter(
			(agent) =>
				!config.capabilities.length ||
				agent.capabilities.some((name) => matchesAgentCapability(name, config.capabilities)),
		)
		const file = (id: number) => `${collection}-${pool.poolId}-${id}.json`
		const validId = (id: number | undefined) => Number.isSafeInteger(id) && Number(id) > 0
		const files = validId(pool.poolId) ? targets.filter((agent) => validId(agent.id)).map((agent) => file(agent.id)) : []
		const readings = files.length
			? await this.read(config.diskMetricsFolder, files).catch(() => ({}) as Record<string, string>)
			: {}
		for (const agent of targets) {
			try {
				if (!validId(pool.poolId) || !validId(agent.id)) throw new Error("Missing identity")
				agent.disk = parseAgentDisk(readings[file(agent.id)], collection, pool.poolId!, agent.id)
				agent.diskError = ""
			} catch {
				agent.diskError = "Disk reading unavailable. Check the collector and shared folder."
			}
		}
		return { ...pool, agents }
	}
}
