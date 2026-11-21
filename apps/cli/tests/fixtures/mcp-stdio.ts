import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
	const request = JSON.parse(line);
	if (request.id === undefined) continue;
	let result: unknown;
	if (request.method === "initialize")
		result = {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "cli-fixture", version: "1.0" },
		};
	else if (request.method === "tools/list")
		result = {
			tools: [
				{
					name: "echo",
					description: "Echo fixture input",
					inputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
			],
		};
	else if (request.method === "tools/call")
		result = {
			content: [{ type: "text", text: request.params.arguments.value }],
		};
	else result = {};
	process.stdout.write(
		`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`,
	);
}
