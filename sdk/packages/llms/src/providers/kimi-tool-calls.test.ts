import type {
	AgentMessage,
	AgentModelEvent,
	AgentToolDefinition,
	GatewayProviderContext,
	GatewayStreamRequest,
} from "@plinycode/shared";
import { NoSuchToolError } from "ai";
import { describe, expect, it } from "vitest";
import { createOpenAICompatibleProvider } from "./ai-sdk";
import { repairMalformedToolCall } from "./ai-sdk-message-convert";
import { describeUnavailableToolCall } from "./ai-sdk-stream-events";
import {
	parseGluedToolCall,
	resolveMisnamedTool,
	withKimiToolCallIds,
} from "./kimi-tool-calls";

/**
 * Kimi K2.6 tool calls as they reached PlinyCode through the Pliny gateway in
 * real FreeAuto sessions: glued into the tool name, left in the reply text,
 * and with call ids the model copied from its own history.
 */

const TOOLS = [
	"skills",
	"read_files",
	"search_codebase",
	"editor",
	"plinycode-devops__pr_create",
	"run_commands",
	"wait",
];

const FILES = {
	files: [
		{ path: "d:\\dev0\\GPUSurfer\\scripts\\conan\\Conan_Installation.bat" },
		{ path: "d:\\dev0\\GPUSurfer\\scripts\\repo\\setup_lfs_credentials.bat" },
	],
};

/** Tool names exactly as the gateway delivered them, arguments empty. */
const GLUED_NAMES = [
	` functions-read_files-2-4wzk2r ${JSON.stringify(FILES)} <|tool_call_end|> <|tool_calls_section_end|>`,
	` functions-read-files-4-m8xz7x6a1f0a008 ${JSON.stringify(FILES)} <|tool_call_end|> <|tool_calls_section_end|>`,
	` functions-read-files-5-w53hn3x5d032008 ${JSON.stringify(FILES)} <|tool_call_end|> <|tool_calls_section_end|>`,
];

describe("resolveMisnamedTool", () => {
	it.each([
		["functions.read_files:3", "read_files"],
		["functions-read_files-2-4wzk2r", "read_files"],
		["functions-read-files-5-w53hn3x5d032008", "read_files"],
		["functions-run-commands-0-ca476m3kqt6mhr", "run_commands"],
		["run_commands:17", "run_commands"],
		["readFiles", "read_files"],
		["functions.searchCodebase", "search_codebase"],
		["functions.plinycode-devops__pr_create:4", "plinycode-devops__pr_create"],
	])("reads the tool out of the call id %s", (emitted, expected) => {
		expect(resolveMisnamedTool(emitted, TOOLS)).toBe(expected);
	});

	it.each([
		// An opaque id names no tool.
		"chatcmpl-tool-916f85da7b18bc65",
		"call_92d46e95896a0361",
		// A suffix that is not a call index is a different tool.
		"read_files_v2",
		"read_filesystem",
		"functions.deploy:0",
	])("leaves %s unresolved", (emitted) => {
		expect(resolveMisnamedTool(emitted, TOOLS)).toBeUndefined();
	});

	it("does not guess between two tools that read the same without separators", () => {
		expect(
			resolveMisnamedTool("readFiles", ["read_files", "read-files"]),
		).toBeUndefined();
	});
});

describe("parseGluedToolCall", () => {
	it.each(GLUED_NAMES)("takes the tool and its arguments out of %s", (name) => {
		const call = parseGluedToolCall(name, TOOLS);
		expect(call?.toolName).toBe("read_files");
		expect(JSON.parse(call?.input ?? "null")).toEqual(FILES);
	});

	it("reads Kimi's own format, argument token included", () => {
		const call = parseGluedToolCall(
			'functions.run_commands:17 <|tool_call_argument_begin|> {"commands": ["git status"]} <|tool_call_end|>',
			TOOLS,
		);
		expect(call).toEqual({
			toolName: "run_commands",
			input: '{"commands":["git status"]}',
		});
	});

	it("returns only the tool when the name carries no arguments", () => {
		expect(
			parseGluedToolCall(" functions-wait-3 <|tool_call_end|>", TOOLS),
		).toEqual({ toolName: "wait" });
	});

	it("gives up when the leading name is not a tool", () => {
		// Kimi opening a call with an id copied from its history: there is no
		// tool name to recover.
		expect(
			parseGluedToolCall(
				" chatcmpl-tool-92d46e95896a0361Remove-Item fix_conflicts.py\ngit status",
				TOOLS,
			),
		).toBeUndefined();
		expect(parseGluedToolCall('{"commands": ["ls"]}', TOOLS)).toBeUndefined();
		expect(parseGluedToolCall("   ", TOOLS)).toBeUndefined();
	});
});

describe("repairMalformedToolCall with a glued call", () => {
	const repair = (toolName: string, input: string) =>
		repairMalformedToolCall({
			toolCall: {
				toolCallId: "chatcmpl-tool-916f85da7b18bc65",
				toolName,
				input,
			},
			error: new NoSuchToolError({ toolName, availableTools: TOOLS }),
		});

	it.each([
		"",
		"{}",
	])("moves the arguments out of the name when the call's own are %j", async (input) => {
		const repaired = await repair(GLUED_NAMES[0] ?? "", input);
		expect(repaired?.toolName).toBe("read_files");
		expect(JSON.parse(repaired?.input ?? "null")).toEqual(FILES);
	});

	it("keeps the call's own arguments when it has any", async () => {
		const repaired = await repair(
			'functions-read_files-2-4wzk2r {"files": []}',
			'{"files": [{"path": "a.ts"}]}',
		);
		expect(repaired?.toolName).toBe("read_files");
		expect(repaired?.input).toBe('{"files": [{"path": "a.ts"}]}');
	});

	it("still rejects a name that holds no tool", async () => {
		expect(
			await repair(" chatcmpl-tool-92d46e95896a0361Remove-Item x", ""),
		).toBeNull();
	});
});

describe("describeUnavailableToolCall", () => {
	it("quotes a glued call back briefly and without control tokens", () => {
		const message = describeUnavailableToolCall({
			toolName: ` chatcmpl-tool-92d46e ${"x".repeat(400)} <|tool_call_end|> <|tool_calls_section_end|>`,
			availableTools: TOOLS,
			providerId: "pliny",
			modelId: "snps-provider/kimi-k2.6",
		});
		expect(message).not.toContain("<|");
		expect(message).toContain('no tool is named "chatcmpl-tool-92d46e xxx');
		expect(message.length).toBeLessThan(500);
		expect(message).toContain("Available tools: skills, read_files,");
	});
});

function message(role: AgentMessage["role"], content: unknown[]): AgentMessage {
	return {
		id: `m_${role}`,
		role,
		content,
		createdAt: 0,
	} as unknown as AgentMessage;
}

const call = (toolCallId: string, toolName: string) => ({
	type: "tool-call",
	toolCallId,
	toolName,
	input: {},
});
const result = (toolCallId: string, toolName: string) => ({
	type: "tool-result",
	toolCallId,
	toolName,
	output: "ok",
});

/** The ids of one real conversation, in order: correct, drifted, server-assigned. */
const HISTORY = [
	message("user", [{ type: "text", text: "where is the token saved?" }]),
	message("assistant", [call("functions.run_commands:0", "run_commands")]),
	message("tool", [result("functions.run_commands:0", "run_commands")]),
	message("assistant", [
		{ type: "text", text: "Let me look." },
		call("functions-run-commands:1", "run_commands"),
	]),
	message("tool", [result("functions-run-commands:1", "run_commands")]),
	message("assistant", [
		call("chatcmpl-tool-916f85da7b18bc65", GLUED_NAMES[0] ?? ""),
	]),
	message("tool", [
		result("chatcmpl-tool-916f85da7b18bc65", GLUED_NAMES[0] ?? ""),
	]),
	message("assistant", [call("functions.read_files:3", "read_files")]),
	message("tool", [result("functions.read_files:3", "read_files")]),
];

function toolIds(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((entry) =>
		entry.content.flatMap((part) =>
			part.type === "tool-call" || part.type === "tool-result"
				? [`${part.type}=${part.toolCallId}`]
				: [],
		),
	);
}

describe("withKimiToolCallIds", () => {
	it("numbers every call the way Kimi does, and its result with it", () => {
		expect(toolIds(withKimiToolCallIds(HISTORY, TOOLS))).toEqual([
			"tool-call=functions.run_commands:0",
			"tool-result=functions.run_commands:0",
			"tool-call=functions.run_commands:1",
			"tool-result=functions.run_commands:1",
			"tool-call=functions.read_files:2",
			"tool-result=functions.read_files:2",
			"tool-call=functions.read_files:3",
			"tool-result=functions.read_files:3",
		]);
	});

	it("leaves the stored messages and everything but the ids alone", () => {
		const before = JSON.stringify(HISTORY);
		const rewritten = withKimiToolCallIds(HISTORY, TOOLS);
		expect(JSON.stringify(HISTORY)).toBe(before);
		// Already-canonical messages are passed through as they are.
		expect(rewritten[0]).toBe(HISTORY[0]);
		expect(rewritten[1]).toBe(HISTORY[1]);
		expect(rewritten[3]?.content[0]).toEqual({
			type: "text",
			text: "Let me look.",
		});
	});

	it("keeps a reused id apart and leaves an orphaned result alone", () => {
		const reused = [
			message("assistant", [call("call_1", "wait")]),
			message("tool", [result("call_1", "wait")]),
			message("assistant", [call("call_1", "editor")]),
			message("tool", [result("call_1", "editor"), result("gone", "editor")]),
		];
		expect(toolIds(withKimiToolCallIds(reused, TOOLS))).toEqual([
			"tool-call=functions.wait:0",
			"tool-result=functions.wait:0",
			"tool-call=functions.editor:1",
			"tool-result=functions.editor:1",
			"tool-result=gone",
		]);
	});

	it("builds a usable id from a name that holds no tool", () => {
		const garbage = [
			message("assistant", [
				call("x", " chatcmpl-tool-92d4 {oops} <|tool_call_end|>"),
			]),
		];
		expect(toolIds(withKimiToolCallIds(garbage, TOOLS))).toEqual([
			"tool-call=functions.chatcmpl-tool-92d4:0",
		]);
	});
});

const READ_FILES_TOOL: AgentToolDefinition = {
	name: "read_files",
	description: "Read files",
	inputSchema: {
		type: "object",
		properties: { files: { type: "array" } },
		required: ["files"],
	},
};

const RUN_COMMANDS_TOOL: AgentToolDefinition = {
	name: "run_commands",
	description: "Run shell commands",
	inputSchema: {
		type: "object",
		properties: { commands: { type: "array", items: { type: "string" } } },
		required: ["commands"],
	},
};

function sse(deltas: unknown[], finish: string): string {
	const chunk = (delta: unknown, finishReason: string | null = null) =>
		`data: ${JSON.stringify({
			id: "cmpl-1",
			object: "chat.completion.chunk",
			created: 1,
			model: "kimi-k2.6",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`;
	return `${deltas.map((delta) => chunk(delta)).join("")}${chunk({}, finish)}data: [DONE]\n\n`;
}

/** Drives the real adapter against a fake gateway reply; returns the events and the request body it sent. */
async function streamFrom(
	sseBody: string,
	options: { modelId?: string; messages?: AgentMessage[] } = {},
) {
	const modelId = options.modelId ?? "snps-provider/kimi-k2.6";
	let sent: Record<string, unknown> | undefined;
	const config = {
		providerId: "openai-compatible",
		apiKey: "test-key",
		baseUrl: "http://fake.local/v1",
		fetch: (async (_url: unknown, init?: { body?: unknown }) => {
			sent = JSON.parse(String(init?.body ?? "{}"));
			return new Response(sseBody, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		}) as unknown as typeof fetch,
	};
	const provider = await createOpenAICompatibleProvider(config);
	const model = { id: modelId, providerId: "openai-compatible", name: modelId };
	const context = {
		provider: {
			id: "openai-compatible",
			name: "OpenAI Compatible",
			defaultModelId: modelId,
			models: [model],
		},
		model,
		config,
	} as unknown as GatewayProviderContext;
	const request = {
		providerId: "openai-compatible",
		modelId,
		messages: options.messages ?? [
			message("user", [{ type: "text", text: "go on reading" }]),
		],
		tools: [RUN_COMMANDS_TOOL, READ_FILES_TOOL],
	} as unknown as GatewayStreamRequest;
	const events: AgentModelEvent[] = [];
	for await (const event of await provider.stream(request, context)) {
		events.push(event);
	}
	return { events, sent };
}

const toolCalls = (events: AgentModelEvent[]) =>
	events.flatMap((event) =>
		event.type === "tool-call-delta" && event.input !== undefined
			? [
					{
						toolName: event.toolName,
						input: event.input,
						error: (event.metadata as Record<string, unknown> | undefined)
							?.inputParseError,
					},
				]
			: [],
	);
const text = (events: AgentModelEvent[]) =>
	events
		.flatMap((event) => (event.type === "text-delta" ? [event.text] : []))
		.join("");
const finish = (events: AgentModelEvent[]) =>
	events.find((event) => event.type === "finish");

describe("the adapter with Kimi's tool calls", () => {
	it("runs a call that arrived glued into the tool name", async () => {
		const { events } = await streamFrom(
			sse(
				[
					{ role: "assistant", content: "Let me read both files now.  " },
					{
						tool_calls: [
							{
								index: 0,
								id: "chatcmpl-tool-916f85da7b18bc65",
								type: "function",
								function: { name: GLUED_NAMES[0], arguments: "{}" },
							},
						],
					},
				],
				"tool_calls",
			),
		);
		expect(toolCalls(events)).toEqual([
			{ toolName: "read_files", input: FILES, error: undefined },
		]);
		expect(finish(events)).toMatchObject({ reason: "tool-calls" });
	});

	it("runs a call the server left in the reply text, and hides the section", async () => {
		const { events } = await streamFrom(
			sse(
				[
					{
						role: "assistant",
						content: "The script is complete! Let me verify: ",
					},
					{
						content:
							"<|tool_calls_section_begin|> <|tool_call_begin|> functions.run_",
					},
					{
						content:
							'commands:17 <|tool_call_argument_begin|> {"commands": ["git status"]}',
					},
					{ content: " <|tool_call_end|> <|tool_calls_section_end|>" },
				],
				"stop",
			),
		);
		expect(text(events)).toBe("The script is complete! Let me verify: ");
		expect(toolCalls(events)).toEqual([
			{
				toolName: "run_commands",
				input: { commands: ["git status"] },
				error: undefined,
			},
		]);
		expect(finish(events)).toMatchObject({ reason: "tool-calls" });
	});

	it("runs a call another model wrote as text in Anthropic's XML", async () => {
		const { events } = await streamFrom(
			sse(
				[
					{
						role: "assistant",
						content: 'Checking: <invoke name="run_commands">',
					},
					{
						content:
							'<parameter name="commands">["git status"]</parameter></invoke>',
					},
				],
				"stop",
			),
			{ modelId: "snps-provider/glm-5.2" },
		);
		expect(text(events)).toBe("Checking: ");
		expect(toolCalls(events)).toEqual([
			{
				toolName: "run_commands",
				input: { commands: ["git status"] },
				error: undefined,
			},
		]);
		expect(finish(events)).toMatchObject({ reason: "tool-calls" });
	});

	const sentToolIds = (sent: Record<string, unknown> | undefined) =>
		((sent?.messages ?? []) as Array<Record<string, unknown>>).flatMap(
			(entry) => [
				...((entry.tool_calls ?? []) as Array<{ id: string }>).map(
					(entry) => entry.id,
				),
				...(typeof entry.tool_call_id === "string" ? [entry.tool_call_id] : []),
			],
		);

	it("sends Kimi its history with the call ids it writes itself", async () => {
		const { sent } = await streamFrom(
			sse([{ role: "assistant", content: "Done." }], "stop"),
			{
				messages: HISTORY,
			},
		);
		expect(sentToolIds(sent)).toEqual([
			"functions.run_commands:0",
			"functions.run_commands:0",
			"functions.run_commands:1",
			"functions.run_commands:1",
			"functions.read_files:2",
			"functions.read_files:2",
			"functions.read_files:3",
			"functions.read_files:3",
		]);
	});

	it("sends other models the ids as they were stored", async () => {
		const { sent } = await streamFrom(
			sse([{ role: "assistant", content: "Done." }], "stop"),
			{
				modelId: "snps-provider/glm-5.2",
				messages: HISTORY,
			},
		);
		// Not renumbered, and rewritten only as far as Bedrock's id alphabet requires.
		const ids = sentToolIds(sent);
		expect(ids).toContain("chatcmpl-tool-916f85da7b18bc65");
		expect(ids).not.toContain("functions.read_files:2");
		for (const id of ids) {
			expect(id).toMatch(/^[a-zA-Z0-9-]+$/);
		}
	});
});
