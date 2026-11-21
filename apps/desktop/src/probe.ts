import { createInterface } from "node:readline";
import { redact } from "@plinycode/shared/node";
import { guardHostLifetime } from "./host-lifetime";
import { connectServers } from "./mcp";
import { type ConnectedMcpServer, mcpSecretValues } from "./mcp-contracts";

const reader = createInterface({ input: process.stdin });
guardHostLifetime(reader);
reader.once("line", async (line) => {
	const input = JSON.parse(line) as { server: ConnectedMcpServer; cwd: string };
	try {
		const connected = await connectServers(
			[{ ...input.server, enabled: true }],
			input.cwd,
		);
		const tools = connected.tools.map((tool) =>
			redact(tool.name, mcpSecretValues([input.server])),
		);
		await connected.close();
		process.stdout.write(`${JSON.stringify({ tools })}\n`);
	} catch (error) {
		process.stdout.write(
			`${JSON.stringify({ error: redact(String(error instanceof Error ? error.message : error), mcpSecretValues([input.server])) })}\n`,
		);
	}
});
// The host owns and kills this tree, including any descendants left by a server.
setInterval(() => {}, 60_000);
