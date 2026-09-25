/**
 * Entry point of the devops-mcp server process (bundled to dist/devops-mcp.js).
 *
 * The extension starts it with the editor's own runtime (`process.execPath` with
 * ELECTRON_RUN_AS_NODE=1), so users need neither Node nor Python installed. It
 * speaks MCP over stdio; stdout carries protocol messages only.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { DevOpsError } from "./errors"
import { createTools, INSTRUCTIONS } from "./tools"

declare const __DEVOPS_MCP_VERSION__: string

export function createServer(): McpServer {
	const version = typeof __DEVOPS_MCP_VERSION__ === "string" ? __DEVOPS_MCP_VERSION__ : "dev"
	const server = new McpServer({ name: "plinycode-devops", version }, { instructions: INSTRUCTIONS })
	for (const tool of createTools()) {
		server.registerTool(
			tool.name,
			{
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
				annotations: {
					title: tool.title,
					readOnlyHint: tool.readOnly,
					destructiveHint: tool.name === "pr_update",
					openWorldHint: true,
				},
			},
			async (args: Record<string, unknown>) => {
				try {
					return { content: [{ type: "text" as const, text: await tool.run(args) }] }
				} catch (error) {
					// Errors we raise on purpose are written for the model; anything else is a bug worth reporting as-is.
					const message = error instanceof DevOpsError ? error.message : `Unexpected error: ${String(error)}`
					return { content: [{ type: "text" as const, text: message }], isError: true }
				}
			},
		)
	}
	return server
}

async function main(): Promise<void> {
	// Never resolve git/gh/az from the repository folder on Windows (same rule as the extension).
	process.env.NoDefaultCurrentDirectoryInExePath = "1"
	await createServer().connect(new StdioServerTransport())
}

if (require.main === module) {
	main().catch((error) => {
		// Separate process: no extension Logger here. The host forwards stderr to its output channel.
		process.stderr.write(`[devops-mcp] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
		process.exit(1)
	})
}
