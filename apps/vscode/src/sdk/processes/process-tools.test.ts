import type { AgentTool, AgentToolContext } from "@plinycode/shared"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { sdkToolToClineSayTool, withToolOutputContent } from "../message-translator/tool-mapping"
import { ProcessRegistry } from "./process-registry"
import { createProcessTools } from "./process-tools"

const context: AgentToolContext = { agentId: "agent-1", sessionId: "session-1", iteration: 1 }
const tempDirs: string[] = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true })
	}
})

function writeLog(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "process-tools-"))
	tempDirs.push(dir)
	const file = path.join(dir, "out.log")
	fs.writeFileSync(file, content)
	return file
}

function setup(now = 200_000) {
	const registry = new ProcessRegistry(() => 0)
	const tools = createProcessTools({ registry, now: () => now })
	const byName = (name: string): AgentTool => {
		const tool = tools.find((candidate) => candidate.name === name)
		if (!tool) {
			throw new Error(`no tool ${name}`)
		}
		return tool
	}
	return {
		registry,
		list: byName("process_list"),
		output: byName("process_output"),
		kill: byName("process_kill"),
	}
}

function register(registry: ProcessRegistry, overrides: Partial<Parameters<ProcessRegistry["register"]>[0]> = {}) {
	return registry.register({
		conversationId: "session-1",
		command: "npm run dev",
		cwd: "/workspace",
		source: "child",
		logPath: "/nowhere/out.log",
		kill: async () => {},
		...overrides,
	})
}

describe("process_list", () => {
	it("lists this conversation's processes, one line each", async () => {
		const { registry, list } = setup()
		register(registry, { logPath: "/logs/a.log" })
		const done = register(registry, { command: "bun test", logPath: "/logs/b.log" })
		registry.markExited(done.id, 1)
		register(registry, { conversationId: "session-2", command: "not mine" })
		register(registry, { command: `node -e "${"x".repeat(120)}"` })

		const text = String(await list.execute({}, context))
		const lines = text.split("\n")

		expect(lines[0]).toBe("id  status  elapsed  command  log")
		expect(lines[1]).toBe("p1  running  3m20s  npm run dev  /logs/a.log")
		expect(lines[2]).toMatch(/^p2 {2}exited\(1\) {2}0s {2}bun test {2}\/logs\/b\.log$/)
		expect(text).not.toContain("not mine")
		expect(lines[3]).toContain("…")
		expect(lines[3].split("  ")[3].length).toBeLessThanOrEqual(80)
		expect(list.executionMode).toBe("parallel")
	})

	it("says when there are none", async () => {
		const { list } = setup()
		expect(await list.execute({}, context)).toBe("No background processes in this conversation.")
	})
})

describe("process_output", () => {
	it("returns the tail of the log with the process state", async () => {
		const { registry, output } = setup()
		const lines = Array.from({ length: 300 }, (_, index) => `line ${index + 1}`)
		const process = register(registry, { logPath: writeLog(`${lines.join("\n")}\n`) })

		const text = String(await output.execute({ id: process.id, tail_lines: 5 }, context))

		expect(text).toContain("p1 has been running for 3m20s: npm run dev")
		expect(text).toContain(`Log: ${process.logPath}`)
		expect(text).toContain("Last 5 lines:")
		expect(text.endsWith("line 296\nline 297\nline 298\nline 299\nline 300")).toBe(true)
		expect(text).not.toContain("line 295\n")
	})

	it("defaults to 100 lines, caps at 400 lines and 32 KB, and strips terminal colors", async () => {
		const { registry, output } = setup()
		const many = Array.from({ length: 1000 }, (_, index) => `\u001b[32mrow ${index + 1}\u001b[0m`)
		const process = register(registry, { logPath: writeLog(many.join("\n")) })

		const byDefault = String(await output.execute({ id: process.id }, context))
		expect(byDefault).toContain("Last 100 lines:")
		expect(byDefault).toContain("row 901")
		expect(byDefault).not.toContain("\u001b")

		const capped = String(await output.execute({ id: process.id, tail_lines: 5000 }, context))
		expect(capped).toContain("Last 400 lines:")

		const wide = register(registry, { logPath: writeLog(Array.from({ length: 400 }, () => "y".repeat(200)).join("\n")) })
		const cut = String(await output.execute({ id: wide.id, tail_lines: 400 }, context))
		expect(cut).toMatch(/Last \d+ lines \(cut to 32 KB\):/)
		expect(Buffer.byteLength(cut)).toBeLessThan(34 * 1024)
	})

	it("reports an ended process, an empty log and a missing one", async () => {
		const { registry, output } = setup()
		const ended = register(registry, { logPath: writeLog("") })
		registry.markExited(ended.id, 3)
		expect(String(await output.execute({ id: ended.id }, context))).toMatch(
			/p1 exited with code 3 after 0s: npm run dev\nLog: .+ \(0 B\)\nThe log is empty so far\./,
		)

		const gone = register(registry)
		expect(String(await output.execute({ id: gone.id }, context))).toContain(
			"The log file /nowhere/out.log no longer exists.",
		)
	})

	it("refuses a process of another conversation, and an unknown id", async () => {
		const { registry, output } = setup()
		const other = register(registry, { conversationId: "session-2" })

		await expect(output.execute({ id: other.id }, context)).rejects.toThrow("No background process p1 in this conversation")
		await expect(output.execute({ id: "p7" }, context)).rejects.toThrow("No background process p7")
		await expect(output.execute({}, context)).rejects.toThrow("Give the process `id`")
	})

	it("shares the root conversation with a sub-agent, which runs under the same session id", async () => {
		const { registry, list } = setup()
		register(registry)
		const subAgent: AgentToolContext = { agentId: "sub-1", sessionId: "session-1", iteration: 1 }
		expect(String(await list.execute({}, subAgent))).toContain("p1  running")
	})
})

describe("process_kill", () => {
	it("stops a running process through the registry", async () => {
		const { registry, kill } = setup()
		const stop = vi.fn(async () => {
			registry.markExited(process.id, 130)
		})
		const process = register(registry, { kill: stop })

		const text = String(await kill.execute({ id: process.id }, context))

		expect(stop).toHaveBeenCalledOnce()
		expect(text).toContain("p1 was stopped after 0s: npm run dev")
		expect(registry.get(process.id)?.status).toBe("killed")
		expect(kill.executionMode).not.toBe("parallel")
	})

	it("reports unconfirmed and failed stop attempts without claiming success", async () => {
		const { registry, kill, list, output } = setup()
		const process = register(registry)
		expect(String(await kill.execute({ id: process.id }, context))).toContain("termination has not been confirmed")
		expect(String(await list.execute({}, context))).toContain("p1  stopping")
		expect(String(await output.execute({ id: process.id }, context))).toContain("stop request pending")
		const failed = register(registry, {
			kill: async () => {
				throw new Error("access denied")
			},
		})
		expect(String(await kill.execute({ id: failed.id }, context))).toContain("could not be stopped: access denied")
		expect(String(await list.execute({}, context))).toContain("p2  stop-failed")
		registry.markLost(process.id)
		const unknown = String(await kill.execute({ id: process.id }, context))
		expect(unknown).toContain("may still be running")
		expect(unknown).not.toContain("nothing to stop")
	})

	it("does nothing to a process that already ended", async () => {
		const { registry, kill } = setup()
		const stop = vi.fn(async () => {})
		const process = register(registry, { kill: stop })
		registry.markExited(process.id, 0)

		expect(await kill.execute({ id: process.id }, context)).toBe("p1 exited with code 0 after 0s; nothing to stop.")
		expect(stop).not.toHaveBeenCalled()
	})
})

describe("chat rows", () => {
	it("maps the tools to rows that show their answer", () => {
		expect(sdkToolToClineSayTool("process_list", {})).toEqual({ tool: "processList" })
		expect(sdkToolToClineSayTool("process_output", { id: "p3", tail_lines: 20 })).toEqual({
			tool: "processOutput",
			path: "p3",
		})
		const killRow = sdkToolToClineSayTool("process_kill", { id: "p3" })
		expect(killRow).toEqual({ tool: "processKill", path: "p3" })
		expect(withToolOutputContent(killRow, "process_kill", "p3 was stopped after 4s")).toEqual({
			tool: "processKill",
			path: "p3",
			content: "p3 was stopped after 4s",
		})
	})
})
