import type { AgentModelEvent, AgentToolDefinition } from "@plinycode/shared";
import { describe, expect, it, vi } from "vitest";
import { createGateway } from "./gateway";

const tool: AgentToolDefinition = {
	name: "read_files",
	description: "Read files",
	inputSchema: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

function sse(events: Record<string, unknown>[]) {
	return events
		.map(
			(event) =>
				`event: ${event.type ?? "message"}\ndata: ${JSON.stringify(event)}\n\n`,
		)
		.join("");
}

const chatResponse = `${sse([
	{
		id: "chat-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "test",
		choices: [{ index: 0, delta: { content: "OK" }, finish_reason: null }],
	},
	{
		id: "chat-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "test",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
	},
])}data: [DONE]\n\n`;

describe("OpenCode Go HTTP integration", () => {
	it.each([
		["openai-compatible", { apiProtocol: "openai-responses" }],
		["opencode-go", {}],
		["opencode-go", { apiProtocol: "unknown" }],
		["opencode-go", { apiProtocol: "anthropic" }],
	])("keeps chat routing regardless of model apiProtocol (%s, %j)", async (providerId, metadata) => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(chatResponse, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const gateway = createGateway({
			providerConfigs: [
				{
					providerId,
					apiKey: "test-key",
					baseUrl: "https://gateway.example/v1",
					models: [{ id: "test-model", name: "Test", metadata }],
					fetch: fetchMock as unknown as typeof fetch,
				},
			],
		});
		for await (const _event of await gateway.stream({
			providerId,
			modelId: "test-model",
			metadata: { sessionId: "test-session" },
			messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
		})) {
			/* Drain the real adapter stream. */
		}
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			"https://gateway.example/v1/chat/completions",
		);
	});

	it.each([
		"glm-5.3",
		"kimi-k2.6",
	])("routes %s with conversation headers, tools, and stream decoding", async (modelId) => {
		const fetchMock = vi.fn(
			async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
				new Response(chatResponse, {
					headers: { "content-type": "text/event-stream" },
				}),
		);
		const gateway = createGateway({
			providerConfigs: [
				{
					providerId: "opencode-go",
					apiKey: "test-key",
					fetch: fetchMock as unknown as typeof fetch,
				},
			],
		});
		for (const sessionId of [
			"conversation-a",
			"conversation-a",
			"conversation-b",
		]) {
			const events: AgentModelEvent[] = [];
			for await (const event of await gateway.stream({
				providerId: "opencode-go",
				modelId,
				metadata: { sessionId },
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "Inspect the project" }],
					},
				],
				tools: [tool],
			}))
				events.push(event);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "text-delta", text: "OK" }),
			);
			expect(events).toContainEqual(
				expect.objectContaining({ type: "finish", reason: "stop" }),
			);
			const [url, init] = fetchMock.mock.calls.at(-1) ?? [];
			expect(String(url)).toBe(
				"https://opencode.ai/zen/go/v1/chat/completions",
			);
			const headers = new Headers(init?.headers);
			expect(headers.get("x-opencode-session")).toBe(sessionId);
			expect(headers.get("user-agent")).toContain("PlinyCode/");
			expect(headers.get("authorization")).toBe("Bearer test-key");
			const body = JSON.parse(String(init?.body));
			expect(body.model).toBe(modelId);
			expect(body.tools).toHaveLength(1);
			expect(body.tools[0].function.name).toBe("read_files");
		}
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
