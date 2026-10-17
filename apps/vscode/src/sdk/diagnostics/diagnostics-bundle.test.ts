import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it } from "vitest"
import { writeDiagnosticsBundle } from "./diagnostics-bundle"
import { redactText, redactValue } from "./redact"

type DiagnosticsBundleDeps = Parameters<typeof writeDiagnosticsBundle>[0]

const tempDirs: string[] = []

async function tempDataDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pliny-diag-"))
	tempDirs.push(dir)
	return dir
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

const FIXED_NOW = new Date(2026, 9, 17, 9, 5, 3)

function baseDeps(dataDir: string, overrides: Partial<DiagnosticsBundleDeps> = {}): DiagnosticsBundleDeps {
	return {
		dataDir,
		now: () => FIXED_NOW,
		versions: { plinycode: "0.2.3-test.2", editor: "Visual Studio Code", editorVersion: "1.105.0" },
		editorSettings: { "plinycode.context.editorState": true },
		globalState: { mode: "act", preferredLanguage: "English" },
		...overrides,
	}
}

async function read(dir: string, relative: string): Promise<string> {
	return fs.readFile(path.join(dir, relative), "utf8")
}

async function exists(filePath: string): Promise<boolean> {
	return fs
		.access(filePath)
		.then(() => true)
		.catch(() => false)
}

describe("writeDiagnosticsBundle", () => {
	it("names the folder after the time and lists everything that was not available", async () => {
		const dataDir = await tempDataDir()
		const result = await writeDiagnosticsBundle(baseDeps(dataDir))

		expect(result.dir).toBe(path.join(dataDir, "diagnostics", "20261017-090503"))
		expect(result.included).toEqual(["README.md", "versions.json", "settings.json", "last-model-request.txt"])
		expect(await read(result.dir, "last-model-request.txt")).toBe("not captured\n")

		const readme = await read(result.dir, "README.md")
		expect(readme).toContain("# PlinyCode diagnostics bundle")
		expect(readme).toContain("by PlinyCode 0.2.3-test.2, with no conversation displayed.")
		expect(readme).toContain("Read through every file and remove anything you would not share")
		expect(readme).toContain("- `versions.json`:")
		for (const item of [
			"`last-model-request.txt`",
			"`router/*.md`",
			"`router/pliny-free-auto-calls.jsonl`",
			"`router/pliny-free-auto-runs.jsonl`",
			"`trace/`",
			"`logs/plinycode.log`",
			"`mcp-settings.json`",
			"`ci-board.json`",
			"`conversation.md`",
		]) {
			expect(readme).toContain(`- ${item}:`)
		}
		expect(result.missing.map((entry) => entry.item)).toContain("trace/")
		expect(result.missing.find((entry) => entry.item === "logs/plinycode.log")?.reason).toContain("no log file")
	})

	it("writes settings with secret keys left out and secret-looking values redacted", async () => {
		const dataDir = await tempDataDir()
		const result = await writeDiagnosticsBundle(
			baseDeps(dataDir, {
				editorSettings: {
					"plinycode.context.editorState": true,
					"plinycode.devops.apiKey": "sk-abcdefghijklmnop",
					"plinycode.devops.headers": { Authorization: "Bearer abcdefghijklmnop" },
				},
				globalState: {
					mode: "act",
					authNonce: "nonce-value",
					mcpOAuthSecrets: { a: 1 },
					taskHistory: [{ id: "t1", task: "do things" }],
					planModeThinkingBudgetTokens: 2048,
					"cline.generatedMachineId": "machine-123",
					note: "call with Authorization: Bearer abcdefghijklmnop and apiKey=sk-abcdefghijklmnop done",
				},
				workspaceState: { localClineRulesToggles: { "a.md": true } },
				excludedStateKeys: ["authNonce", "mcpOAuthSecrets", "taskHistory"],
			}),
		)

		const settings = JSON.parse(await read(result.dir, "settings.json"))
		expect(settings.editor["plinycode.context.editorState"]).toBe(true)
		expect(settings.editor["plinycode.devops.apiKey"]).toBe("[REDACTED]")
		expect(settings.editor["plinycode.devops.headers"]).toEqual({ Authorization: "[REDACTED]" })
		expect(settings.global.mode).toBe("act")
		expect(settings.global.authNonce).toBeUndefined()
		expect(settings.global.mcpOAuthSecrets).toBeUndefined()
		expect(settings.global.taskHistory).toBeUndefined()
		expect(settings.global["cline.generatedMachineId"]).toBe("[REDACTED]")
		expect(settings.global.planModeThinkingBudgetTokens).toBe(2048)
		expect(settings.global.note).toBe("call with Authorization: Bearer [REDACTED] and apiKey=[REDACTED] done")
		expect(settings.workspace.localClineRulesToggles).toEqual({ "a.md": true })
		expect(JSON.stringify(settings)).not.toContain("sk-abc")
		expect(JSON.stringify(settings)).not.toContain("nonce-value")
	})

	it("keeps the last 500 lines of the router logs and copies the rules files", async () => {
		const dataDir = await tempDataDir()
		const lines = Array.from({ length: 650 }, (_, index) => JSON.stringify({ line: index + 1 }))
		await fs.writeFile(path.join(dataDir, "pliny-free-auto-calls.jsonl"), `${lines.join("\n")}\n`)
		await fs.writeFile(path.join(dataDir, "pliny-free-auto-runs.jsonl"), `${lines.slice(0, 3).join("\n")}\n`)
		await fs.writeFile(path.join(dataDir, "pliny-free-auto.md"), "# rules\n")
		await fs.writeFile(path.join(dataDir, "pliny-free-auto.fast.md"), "# fast rules\n")
		await fs.writeFile(path.join(dataDir, "pliny-balance-auto.md"), "# balance rules\n")
		await fs.writeFile(path.join(dataDir, "pliny-free-auto-calls.jsonl.bak"), "not a log\n")

		const result = await writeDiagnosticsBundle(baseDeps(dataDir))

		const calls = (await read(result.dir, "router/pliny-free-auto-calls.jsonl")).trimEnd().split("\n")
		expect(calls).toHaveLength(500)
		expect(calls[0]).toBe(JSON.stringify({ line: 151 }))
		expect(calls[499]).toBe(JSON.stringify({ line: 650 }))
		expect((await read(result.dir, "router/pliny-free-auto-runs.jsonl")).trimEnd().split("\n")).toHaveLength(3)
		expect(await read(result.dir, "router/pliny-free-auto.fast.md")).toBe("# fast rules\n")
		expect(await read(result.dir, "router/pliny-balance-auto.md")).toBe("# balance rules\n")
		expect(result.included).toContain("router/pliny-free-auto.md")
		expect(result.included).not.toContain("router/pliny-free-auto-calls.jsonl.bak")

		const readme = await read(result.dir, "README.md")
		expect(readme).toContain("- `router/pliny-free-auto-calls.jsonl`: the last 500 lines of the router's log.")
		expect(readme).toContain("- `router/pliny-free-auto-runs.jsonl`: the router's log, whole.")
	})

	it("copies the conversation's trace, cut to whole lines within the cap", async () => {
		const dataDir = await tempDataDir()
		const tracesDir = path.join(dataDir, "traces")
		await fs.mkdir(tracesDir)
		const lines = Array.from({ length: 200 }, (_, index) => JSON.stringify({ type: "stream", index }))
		await fs.writeFile(path.join(tracesDir, "sess-1.jsonl"), `${lines.join("\n")}\n`)
		await fs.writeFile(path.join(tracesDir, "sess-other.jsonl"), "other\n")

		const result = await writeDiagnosticsBundle(baseDeps(dataDir, { sessionId: "sess-1", traceMaxBytes: 1024 }))

		const copy = await read(result.dir, "trace/sess-1.jsonl")
		expect(Buffer.byteLength(copy)).toBeLessThanOrEqual(1024)
		expect(copy.startsWith('{"type":"stream"')).toBe(true)
		expect(copy.endsWith(`${lines[199]}\n`)).toBe(true)
		expect(await exists(path.join(result.dir, "trace", "sess-other.jsonl"))).toBe(false)
		expect(await read(result.dir, "README.md")).toContain("the conversation's trace, cut to its last 1 KB")
	})

	it("copies a short trace whole", async () => {
		const dataDir = await tempDataDir()
		await fs.mkdir(path.join(dataDir, "traces"))
		await fs.writeFile(path.join(dataDir, "traces", "sess-1.jsonl"), '{"type":"request"}\n')

		const result = await writeDiagnosticsBundle(baseDeps(dataDir, { sessionId: "sess-1" }))

		expect(await read(result.dir, "trace/sess-1.jsonl")).toBe('{"type":"request"}\n')
		expect(await read(result.dir, "README.md")).toContain("- `trace/sess-1.jsonl`: the conversation's trace.")
	})

	it("copies the current and the newest rotated log file only", async () => {
		const dataDir = await tempDataDir()
		const logsDir = path.join(dataDir, "logs")
		await fs.mkdir(logsDir)
		await fs.writeFile(path.join(logsDir, "plinycode.log"), "current\n")
		await fs.writeFile(path.join(logsDir, "plinycode.1.log"), "rotated\n")
		await fs.writeFile(path.join(logsDir, "plinycode.2.log"), "older\n")

		const result = await writeDiagnosticsBundle(baseDeps(dataDir))

		expect(await read(result.dir, "logs/plinycode.log")).toBe("current\n")
		expect(await read(result.dir, "logs/plinycode.1.log")).toBe("rotated\n")
		expect(await exists(path.join(result.dir, "logs", "plinycode.2.log"))).toBe(false)
	})

	it("says when the log has not rotated yet", async () => {
		const dataDir = await tempDataDir()
		await fs.mkdir(path.join(dataDir, "logs"))
		await fs.writeFile(path.join(dataDir, "logs", "plinycode.log"), "current\n")

		const result = await writeDiagnosticsBundle(baseDeps(dataDir))

		expect(result.missing).toContainEqual({ item: "logs/plinycode.1.log", reason: "the log has not rotated yet" })
	})

	it("redacts MCP settings and the CI board file key by key", async () => {
		const dataDir = await tempDataDir()
		const mcpPath = path.join(dataDir, "settings", "cline_mcp_settings.json")
		await fs.mkdir(path.dirname(mcpPath))
		await fs.writeFile(
			mcpPath,
			JSON.stringify({
				mcpServers: {
					github: {
						command: "npx",
						args: ["server", "--token", "ghp_abcdefghijklmnopqrstuvwxyz0123"],
						env: { GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz0123", HOME: "/home/me" },
						headers: { Authorization: "Bearer abcdefghijklmnop", Accept: "application/json" },
						apiKey: "sk-abcdefghijklmnop",
						url: "https://example.test/mcp",
						timeout: 60,
						disabled: false,
					},
				},
			}),
		)
		const ciBoardPath = path.join(dataDir, "ci-board.json")
		await fs.writeFile(ciBoardPath, JSON.stringify({ targets: [{ repo: "org/repo", pat: "secret-pat" }] }))

		const result = await writeDiagnosticsBundle(baseDeps(dataDir, { mcpSettingsPath: mcpPath, ciBoardPath }))

		const mcp = JSON.parse(await read(result.dir, "mcp-settings.json")).mcpServers.github
		expect(mcp.command).toBe("npx")
		expect(mcp.args).toEqual(["server", "--token", "[REDACTED]"])
		expect(mcp.env).toEqual({ GITHUB_TOKEN: "[REDACTED]", HOME: "[REDACTED]" })
		expect(mcp.headers).toEqual({ Authorization: "[REDACTED]", Accept: "[REDACTED]" })
		expect(mcp.apiKey).toBe("[REDACTED]")
		expect(mcp.url).toBe("https://example.test/mcp")
		expect(mcp.timeout).toBe(60)
		expect(mcp.disabled).toBe(false)

		const board = JSON.parse(await read(result.dir, "ci-board.json"))
		expect(board.targets[0]).toEqual({ repo: "org/repo", pat: "[REDACTED]" })
	})

	it("leaves out an MCP settings file it cannot parse rather than writing it unredacted", async () => {
		const dataDir = await tempDataDir()
		const mcpPath = path.join(dataDir, "cline_mcp_settings.json")
		await fs.writeFile(mcpPath, '{"mcpServers": {"x": {"env": {"TOKEN": "ghp_abcdefghijklmnopqrstuvwxyz0123"}}')

		const result = await writeDiagnosticsBundle(baseDeps(dataDir, { mcpSettingsPath: mcpPath }))

		expect(await exists(path.join(result.dir, "mcp-settings.json"))).toBe(false)
		expect(result.missing.find((entry) => entry.item === "mcp-settings.json")?.reason).toContain("could not be read as JSON")
	})

	it("writes the last model request and the conversation with tokens in their text removed", async () => {
		const dataDir = await tempDataDir()
		const result = await writeDiagnosticsBundle(
			baseDeps(dataDir, {
				sessionId: "sess-1",
				lastModelRequest: '{"systemPrompt": "use Authorization: Bearer abcdefghijklmnop"}',
				renderConversation: async () => "# Conversation\n\nexport TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n",
			}),
		)

		expect(await read(result.dir, "last-model-request.txt")).toBe('{"systemPrompt": "use Authorization: Bearer [REDACTED]"}')
		expect(await read(result.dir, "conversation.md")).toBe("# Conversation\n\nexport TOKEN=[REDACTED]\n")
		expect(await read(result.dir, "README.md")).toContain("for conversation `sess-1`.")
		expect(result.missing.map((entry) => entry.item)).not.toContain("conversation.md")
	})

	it("reports a conversation that fails to render instead of failing the bundle", async () => {
		const dataDir = await tempDataDir()
		const result = await writeDiagnosticsBundle(
			baseDeps(dataDir, {
				sessionId: "sess-1",
				renderConversation: async () => {
					throw new Error("Task not found in history: sess-1")
				},
			}),
		)

		expect(await exists(path.join(result.dir, "conversation.md"))).toBe(false)
		expect(result.missing).toContainEqual({ item: "conversation.md", reason: "Task not found in history: sess-1" })
	})
})

describe("redaction", () => {
	it("recognises keys that name a secret", () => {
		for (const key of [
			"apiKey",
			"api_key",
			"x-api-key",
			"accessToken",
			"mcpOAuthSecrets",
			"authNonce",
			"password",
			"Authorization",
			"pat",
			"plinycode.devops.pat",
			"cline.generatedMachineId",
		]) {
			expect(redactValue({ [key]: "plain value" }), key).toEqual({ [key]: "[REDACTED]" })
		}
		for (const key of ["mode", "planModeApiModelId", "taskHistory", "sessionId", "format", "plinycode.context.editorState"]) {
			expect(redactValue({ [key]: "plain value" }), key).toEqual({ [key]: "plain value" })
		}
	})

	it("replaces secret-looking values inside text", () => {
		expect(redactText("Authorization: Bearer abcdefghijklmnop.qrs")).toBe("Authorization: Bearer [REDACTED]")
		expect(redactText("Basic dXNlcjpwYXNzd29yZA==")).toBe("Basic [REDACTED]")
		expect(redactText("key sk-abcdefghijklmnop here")).toBe("key [REDACTED] here")
		expect(redactText("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe("[REDACTED]")
		expect(redactText("github_pat_abcdefghijklmnopqrstuvwxyz0123")).toBe("[REDACTED]")
		// Built at run time so the secret scanner does not take the fixture for a real key.
		expect(redactText(["AKIA", "ABCDEFGHIJKLMNOP"].join(""))).toBe("[REDACTED]")
		expect(redactText("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijklmnop")).toBe("[REDACTED]")
		expect(redactText("api_key=abcd1234 token: 'xyz98765' password = hunter2")).toBe(
			"api_key=[REDACTED] token: '[REDACTED]' password = [REDACTED]",
		)
		expect(redactText("a plain sentence with a token word and sk- short")).toBe(
			"a plain sentence with a token word and sk- short",
		)
	})

	it("redacts by key, keeps numbers and booleans, and empties env and headers", () => {
		expect(
			redactValue({
				apiKey: "value",
				planModeThinkingBudgetTokens: 2048,
				hooksEnabled: true,
				secret: null,
				env: { A: "1", B: "2" },
				headers: "raw",
				nested: [{ token: "abc" }, "Bearer abcdefghijklmnop"],
			}),
		).toEqual({
			apiKey: "[REDACTED]",
			planModeThinkingBudgetTokens: 2048,
			hooksEnabled: true,
			secret: null,
			env: { A: "[REDACTED]", B: "[REDACTED]" },
			headers: "[REDACTED]",
			nested: [{ token: "[REDACTED]" }, "Bearer [REDACTED]"],
		})
	})
})
