import {
	MAX_MCP_TIMEOUT_SECONDS,
	MIN_MCP_TIMEOUT_SECONDS,
} from "@plinycode/shared";
import { z } from "zod";

export const mcpServerSchema = z
	.object({
		id: z.string().uuid(),
		name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
		enabled: z.boolean(),
		type: z.enum(["stdio", "http", "sse"]),
		command: z.string().max(2000),
		args: z.array(z.string().max(4000)).max(100),
		cwd: z.string().max(4000),
		url: z.string().max(4000),
		timeout: z
			.number()
			.int()
			.min(MIN_MCP_TIMEOUT_SECONDS)
			.max(MAX_MCP_TIMEOUT_SECONDS),
		hasSecrets: z.boolean().default(false),
	})
	.superRefine((server, ctx) => {
		if (server.type === "stdio") {
			if (!server.command.trim())
				ctx.addIssue({
					code: "custom",
					message: "A stdio server needs a command.",
				});
		} else {
			try {
				const url = new URL(server.url);
				if (
					!["http:", "https:"].includes(url.protocol) ||
					url.username ||
					url.password ||
					url.hash ||
					url.search
				)
					throw new Error("Invalid URL");
			} catch {
				ctx.addIssue({
					code: "custom",
					message:
						"Use an HTTP(S) endpoint without credentials, query parameters or a fragment. Put tokens in encrypted headers.",
				});
			}
		}
	});
export const mcpSecretsSchema = z.object({
	env: z.record(z.string(), z.string()).default({}),
	headers: z.record(z.string(), z.string()).default({}),
});
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpSecrets = z.infer<typeof mcpSecretsSchema>;
export type ConnectedMcpServer = McpServer & { secrets: McpSecrets };

export function mcpSecretValues(servers: ConnectedMcpServer[]): string[] {
	return servers
		.flatMap((server) =>
			[
				...Object.entries(server.secrets.env).filter(([name]) =>
					/key|token|secret|password|credential/i.test(name),
				),
				...Object.entries(server.secrets.headers).filter(([name]) =>
					/authorization|key|token|secret|cookie/i.test(name),
				),
			].map(([, value]) => value),
		)
		.flatMap((value) => [value, value.replace(/^Bearer\s+/i, "")])
		.filter(Boolean);
}
