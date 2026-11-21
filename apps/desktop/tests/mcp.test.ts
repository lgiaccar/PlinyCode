import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentToolContext } from "@plinycode/core";
import { connectServers } from "../src/mcp";
import { type ConnectedMcpServer, mcpServerSchema } from "../src/mcp-contracts";
import { SecretVault } from "../src/vault";

const scratch = resolve(import.meta.dir, "../../../ai_output");
function response(request: {
	id?: number;
	method: string;
	params?: { protocolVersion?: string; arguments?: { value?: string } };
}) {
	const result =
		request.method === "initialize"
			? {
					protocolVersion: request.params?.protocolVersion,
					capabilities: { tools: {} },
					serverInfo: { name: "desktop-fixture", version: "1" },
				}
			: request.method === "tools/list"
				? {
						tools: [
							{
								name: "echo",
								description: "Echo",
								inputSchema: {
									type: "object",
									properties: { value: { type: "string" } },
								},
							},
						],
					}
				: request.method === "tools/call"
					? {
							content: [
								{ type: "text", text: request.params?.arguments?.value },
							],
						}
					: {};
	return { jsonrpc: "2.0", id: request.id, result };
}
for (const type of ["stdio", "http", "sse"] as const) {
	test(`desktop MCP ${type}: authenticated discovery, execution, disconnect`, async () => {
		let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
		const encoder = new TextEncoder();
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				if (request.headers.get("authorization") !== "Bearer fixture-token")
					return new Response(null, { status: 401 });
				if (
					request.method === "GET" &&
					new URL(request.url).pathname === "/sse"
				)
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
				if (request.method !== "POST")
					return new Response(null, { status: 405 });
				const message = (await request.json()) as Parameters<
					typeof response
				>[0];
				if (message.id === undefined)
					return new Response(null, { status: 202 });
				if (new URL(request.url).pathname === "/messages") {
					stream?.enqueue(
						encoder.encode(
							`event: message\ndata: ${JSON.stringify(response(message))}\n\n`,
						),
					);
					return new Response(null, { status: 202 });
				}
				return Response.json(response(message));
			},
		});
		const config: ConnectedMcpServer = {
			id: crypto.randomUUID(),
			name: "fixture",
			enabled: true,
			type,
			command: process.execPath,
			args: [resolve(import.meta.dir, "../../cli/tests/fixtures/mcp-stdio.ts")],
			cwd: "",
			url: `http://127.0.0.1:${server.port}/${type === "sse" ? "sse" : "mcp"}`,
			timeout: 3,
			hasSecrets: true,
			secrets: { env: {}, headers: { Authorization: "Bearer fixture-token" } },
		};
		let connection: Awaited<ReturnType<typeof connectServers>> | undefined;
		try {
			connection = await connectServers([config], scratch);
			expect(connection.tools).toHaveLength(1);
			expect(
				JSON.stringify(
					await connection.tools[0].execute(
						{ value: "desktop-response" },
						{} as AgentToolContext,
					),
				),
			).toContain("desktop-response");
		} finally {
			await connection?.close();
			server.stop(true);
		}
	}, 15_000);
}
test("MCP failure is surfaced and disabled programs are not launched", async () => {
	const config: ConnectedMcpServer = {
		id: crypto.randomUUID(),
		name: "missing",
		enabled: true,
		type: "stdio",
		command: "plinycode-nonexistent-fixture",
		args: [],
		cwd: "",
		url: "",
		timeout: 1,
		hasSecrets: false,
		secrets: { env: {}, headers: {} },
	};
	await expect(connectServers([config], scratch)).rejects.toThrow();
	const disabled = await connectServers(
		[{ ...config, enabled: false }],
		scratch,
	);
	expect(disabled.tools).toHaveLength(0);
	await disabled.close();
	expect(
		mcpServerSchema.safeParse({
			...config,
			type: "http",
			url: "https://user:secret@example.invalid/mcp",
		}).success,
	).toBe(false);
});
test("MCP HTTP connections have a bounded timeout", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response(new ReadableStream({}), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const config: ConnectedMcpServer = {
		id: crypto.randomUUID(),
		name: "timeout",
		enabled: true,
		type: "http",
		command: "",
		args: [],
		cwd: "",
		url: `http://127.0.0.1:${server.port}/mcp`,
		timeout: 1,
		hasSecrets: false,
		secrets: { env: {}, headers: {} },
	};
	try {
		await expect(connectServers([config], scratch)).rejects.toThrow();
	} finally {
		server.stop(true);
	}
}, 10_000);
test("vault refuses plaintext fallback and retains secrets across reopen", async () => {
	await mkdir(scratch, { recursive: true });
	const folder = await mkdtemp(join(scratch, "desktop-vault-")),
		file = join(folder, "vault.json");
	// A deterministic reversible test cipher; real Electron E2E exercises DPAPI.
	const cipher = {
		isEncryptionAvailable: () => true,
		getSelectedStorageBackend: () => "gnome_libsecret",
		encryptString: (text: string) =>
			Buffer.from(Buffer.from(text).map((byte) => byte ^ 0xa5)),
		decryptString: (data: Buffer) =>
			Buffer.from(Buffer.from(data).map((byte) => byte ^ 0xa5)).toString(),
	};
	const vault = new SecretVault(file, cipher),
		secrets = { env: { TOKEN: "vault-fixture-token" }, headers: {} };
	vault.write("fixture", secrets);
	expect(await readFile(file, "utf8")).not.toContain(secrets.env.TOKEN);
	expect(new SecretVault(file, cipher).read("fixture")).toEqual(secrets);
	expect(() =>
		new SecretVault(file, {
			...cipher,
			isEncryptionAvailable: () => false,
		}).write("fixture", secrets),
	).toThrow();
	vault.write("fixture");
	expect(vault.read("fixture")).toEqual({ env: {}, headers: {} });
});
