import { dirname, resolve } from "node:path";
import {
	type AgentTool,
	createDefaultMcpServerClientFactory,
	createMcpTools,
	InMemoryMcpManager,
	resolveMcpServerRegistrations,
} from "@plinycode/core";
import { CliError, type Options } from "./options";
import { redact } from "./output";

export async function connectMcp(
	options: Options,
	approve?: (question: string) => Promise<boolean>,
) {
	const manager = new InMemoryMcpManager({
		clientFactory: createDefaultMcpServerClientFactory({
			restrictConfiguredHeadersToOrigin: true,
		}),
	});
	const tools: AgentTool[] = [];
	const secrets: string[] = [];
	try {
		if (options.mcpConfig) {
			const registrations = resolveMcpServerRegistrations({
				filePath: options.mcpConfig,
			});
			const enabled = registrations.filter((server) => !server.disabled);
			// Discovery itself can launch a stdio process. Authorize before connecting.
			if (
				enabled.length &&
				!options.allowTools &&
				!(await approve?.(
					`Connect MCP servers ${enabled.map((r) => r.name).join(", ")}? This may start local programs.`,
				))
			) {
				throw new CliError(
					"needs_input",
					"MCP connections require approval; use --allow-tools for trusted unattended execution.",
					3,
				);
			}
			for (const server of enabled) {
				const transport = server.transport;
				if (transport.type === "stdio") {
					transport.cwd = transport.cwd
						? resolve(dirname(options.mcpConfig), transport.cwd)
						: options.cwd;
					secrets.push(
						...Object.entries(transport.env ?? {})
							.filter(([name]) =>
								/key|token|secret|password|credential/i.test(name),
							)
							.map(([, value]) => value),
					);
				} else {
					for (const [name, value] of Object.entries(transport.headers ?? {})) {
						if (/authorization|key|token|secret|cookie/i.test(name))
							secrets.push(value, value.replace(/^Bearer\s+/i, ""));
					}
				}
				await manager.registerServer(server);
				tools.push(
					...(await createMcpTools({
						serverName: server.name,
						provider: manager,
						timeoutMs: (server.timeoutSeconds ?? 60) * 1000,
						retryable: false,
					})),
				);
			}
		}
		return { tools, secrets, close: () => manager.dispose() };
	} catch (error) {
		await manager.dispose();
		if (error instanceof CliError) throw error;
		throw new CliError(
			"mcp_failed",
			redact(error instanceof Error ? error.message : String(error), secrets),
			1,
		);
	}
}
