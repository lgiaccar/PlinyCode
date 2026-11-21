import { isAbsolute } from "node:path";
import {
	type AgentTool,
	createDefaultMcpServerClientFactory,
	createMcpTools,
	InMemoryMcpManager,
} from "@plinycode/core";
import { redact } from "@plinycode/shared/node";
import { type ConnectedMcpServer, mcpSecretValues } from "./mcp-contracts";

export async function connectServers(
	servers: ConnectedMcpServer[],
	cwd: string,
) {
	const manager = new InMemoryMcpManager({
		clientFactory: createDefaultMcpServerClientFactory({
			restrictConfiguredHeadersToOrigin: true,
		}),
	});
	const tools: AgentTool[] = [],
		secrets = mcpSecretValues(servers);
	try {
		for (const server of servers.filter((item) => item.enabled)) {
			if (server.cwd && !isAbsolute(server.cwd))
				throw new Error("MCP working folders must be absolute.");
			await manager.registerServer({
				name: server.name,
				timeoutSeconds: server.timeout,
				transport:
					server.type === "stdio"
						? {
								type: "stdio",
								command: server.command,
								args: server.args,
								cwd: server.cwd || cwd,
								env: server.secrets.env,
							}
						: {
								type: server.type === "http" ? "streamableHttp" : "sse",
								url: server.url,
								headers: server.secrets.headers,
							},
			});
			tools.push(
				...(await createMcpTools({
					serverName: server.name,
					provider: manager,
					timeoutMs: server.timeout * 1000,
					retryable: false,
				})),
			);
		}
		return { tools, close: () => manager.dispose() };
	} catch (error) {
		await manager.dispose();
		throw new Error(
			redact(String(error instanceof Error ? error.message : error), secrets),
		);
	}
}
