import type { AgentTool } from "@plinycode/shared"
import sinon from "sinon"
import { afterEach, describe, expect, it, vi } from "vitest"
import { registerBuiltinMcpSource } from "@/services/devops-mcp/builtin-mcp-registry"

// The unit-test stand-in for the engine has no MCP tool factory; this one names
// tools the way the real one does.
vi.mock("@plinycode/core", async () => {
	const actual = await vi.importActual<typeof import("@plinycode/core")>("@plinycode/core")
	return {
		...actual,
		createMcpTools: async (input: {
			serverName: string
			provider: { listTools(server: string): Promise<{ name: string }[]> }
		}) => (await input.provider.listTools(input.serverName)).map((tool) => ({ name: `${input.serverName}__${tool.name}` })),
	}
})

import { createVscodeExtraTools, McpHubToolProvider } from "./vscode-runtime-builder"

describe("McpHubToolProvider", () => {
	it("forwards the agent abort signal to McpHub", async () => {
		const callTool = sinon.stub().resolves({ content: [] })
		const provider = new McpHubToolProvider({ callTool } as never)
		const controller = new AbortController()

		await provider.callTool({
			serverName: "server",
			toolName: "slow-tool",
			context: {
				agentId: "agent",
				iteration: 1,
				signal: controller.signal,
			},
		})

		expect(callTool.calledOnce).toBe(true)
		expect(callTool.firstCall.args[4]).toBe(controller.signal)
	})
})

describe("createVscodeExtraTools with a built-in server", () => {
	let unregister: (() => void) | undefined

	afterEach(() => {
		unregister?.()
		unregister = undefined
	})

	const mcpHub = { getServers: () => [] } as never
	const watchCi = { name: "watch_ci" } as AgentTool

	/** A stand-in for the DevOps server: it only applies to repositories under /github. */
	function registerDevOps(running = true) {
		const extraTools = vi.fn((_cwd: string) => [watchCi])
		unregister = registerBuiltinMcpSource({
			serverName: "plinycode-devops",
			timeoutMs: 1000,
			provider: { listTools: async () => [{ name: "pipeline_runs", inputSchema: {} }], callTool: async () => ({}) },
			isRunning: () => running,
			toolNames: () => ["pipeline_runs"],
			appliesTo: async (cwd) => cwd.startsWith("/github"),
			extraTools,
		})
		return extraTools
	}

	const names = async (cwd: string) => (await createVscodeExtraTools(mcpHub, { cwd })).map((tool) => tool.name)

	it("offers the server's extension-side tools together with its own", async () => {
		const extraTools = registerDevOps()
		expect(await names("/github/repo")).toEqual(["plinycode-devops__pipeline_runs", "watch_ci", "wait", "update_todo_list"])
		expect(extraTools).toHaveBeenCalledWith("/github/repo")
	})

	it("offers neither in a workspace the server does not apply to", async () => {
		const extraTools = registerDevOps()
		expect(await names("/plain/folder")).toEqual(["wait", "update_todo_list"])
		expect(extraTools).not.toHaveBeenCalled()
	})

	it("offers neither while the server is not running", async () => {
		const extraTools = registerDevOps(false)
		expect(await names("/github/repo")).toEqual(["wait", "update_todo_list"])
		expect(extraTools).not.toHaveBeenCalled()
	})
})
