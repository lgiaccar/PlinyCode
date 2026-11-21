import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentToolContext } from "@plinycode/core";
import { connectMcp } from "../src/mcp";
import { parseOptions } from "../src/options";

const scratchRoot = resolve(import.meta.dir, "../../../ai_output");
await mkdir(scratchRoot, { recursive: true });
const scratch = await mkdtemp(join(scratchRoot, "cli-mcp-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true, maxRetries: 5 }));

function reply(request: {
	id?: number;
	method: string;
	params?: { protocolVersion?: string; arguments?: { value?: string } };
}) {
	let result: unknown;
	if (request.method === "initialize")
		result = {
			protocolVersion: request.params?.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "cli-fixture", version: "1.0" },
		};
	else if (request.method === "tools/list")
		result = {
			tools: [
				{
					name: "echo",
					description: "Echo input",
					inputSchema: {
						type: "object",
						properties: { value: { type: "string" } },
					},
				},
			],
		};
	else if (request.method === "tools/call")
		result = {
			content: [{ type: "text", text: request.params?.arguments?.value }],
		};
	else result = {};
	return { jsonrpc: "2.0", id: request.id, result };
}

for (const transport of ["stdio", "sse", "streamableHttp"] as const) {
	test(`MCP ${transport}: discover, execute and disconnect`, async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (
					request.method === "GET" &&
					new URL(request.url).pathname === "/sse"
				) {
					return new Response(
						new ReadableStream({
							start(controller) {
								stream = controller;
								controller.enqueue(
									encoder.encode("event: endpoint\ndata: /messages\n\n"),
								);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				}
				if (request.method !== "POST")
					return new Response(null, { status: 405 });
				const message = (await request.json()) as Parameters<typeof reply>[0];
				if (message.id === undefined)
					return new Response(null, { status: 202 });
				if (new URL(request.url).pathname === "/messages") {
					stream?.enqueue(
						encoder.encode(
							`event: message\ndata: ${JSON.stringify(reply(message))}\n\n`,
						),
					);
					return new Response(null, { status: 202 });
				}
				return Response.json(reply(message));
			},
		});
		const config = join(scratch, `${transport}.json`);
		await writeFile(
			config,
			JSON.stringify({
				mcpServers: {
					fixture:
						transport === "stdio"
							? {
									type: "stdio",
									command: process.execPath,
									args: [resolve(import.meta.dir, "fixtures/mcp-stdio.ts")],
								}
							: {
									type: transport,
									url: `http://127.0.0.1:${server.port}/${transport === "sse" ? "sse" : "mcp"}`,
								},
				},
			}),
		);
		let connected: Awaited<ReturnType<typeof connectMcp>> | undefined;
		try {
			connected = await connectMcp(
				parseOptions(["run", "--allow-tools", "--mcp-config", config]),
			);
			expect(connected.tools).toHaveLength(1);
			const result = await connected.tools[0].execute(
				{ value: "fixture response" },
				{} as AgentToolContext,
			);
			expect(JSON.stringify(result)).toContain("fixture response");
		} finally {
			await connected?.close();
			server.stop(true);
		}
	}, 20000);
}

test("unattended MCP discovery cannot launch a process without permission", async () => {
	const config = join(scratch, "blocked.json");
	await writeFile(
		config,
		JSON.stringify({
			mcpServers: {
				blocked: { type: "stdio", command: "must-not-be-launched" },
			},
		}),
	);
	await expect(
		connectMcp(parseOptions(["run", "--mcp-config", config])),
	).rejects.toMatchObject({ code: "needs_input", exitCode: 3 });
});

test("explicitly requested but unavailable MCP servers fail instead of disappearing", async () => {
	const config = join(scratch, "missing.json");
	await writeFile(
		config,
		JSON.stringify({
			mcpServers: {
				missing: {
					type: "stdio",
					command: "plinycode-fixture-missing-program",
				},
			},
		}),
	);
	await expect(
		connectMcp(parseOptions(["run", "--allow-tools", "--mcp-config", config])),
	).rejects.toThrow();
});
