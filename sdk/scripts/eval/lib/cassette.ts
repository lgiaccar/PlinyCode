/**
 * Builders for hand-written eval cassettes.
 *
 * A cassette is the JSON array `startVcr` (sdk/packages/shared/src/vcr.ts)
 * plays back: one entry per HTTP request, matched in order on method and
 * path. For the Pliny provider every entry is a POST to the gateway's
 * OpenAI-compatible `/chat/completions` endpoint whose response is the
 * server-sent-event stream a chat completion returns with `stream: true`.
 *
 * Cassettes recorded with `run.ts --record` have the same shape; these
 * helpers only exist so seed cases can be written without a live gateway.
 */

import type { VcrRecording } from "@plinycode/shared";

/** One model turn: optional reasoning and text, then optional tool calls. */
export interface ScriptedTurn {
	reasoning?: string;
	text?: string;
	toolCalls?: Array<{ name: string; input: unknown }>;
	usage?: { input: number; output: number };
}

interface ChunkChoice {
	index: number;
	delta: Record<string, unknown>;
	finish_reason: string | null;
}

/** The URL scope and path a Pliny chat completion is sent to. */
export function chatCompletionsEndpoint(baseUrl: string): {
	scope: string;
	path: string;
} {
	const url = new URL(baseUrl);
	const prefix = url.pathname.replace(/\/+$/, "");
	return {
		scope: `${url.protocol}//${url.host}`,
		path: `${prefix}/chat/completions`,
	};
}

/**
 * Render one turn as a chat-completions SSE body. Tool-call arguments are
 * split across two chunks, as real gateways stream them.
 */
export function renderTurnSse(
	turn: ScriptedTurn,
	model: string,
	turnIndex: number,
): string {
	const base = {
		id: `chatcmpl-eval-${turnIndex}`,
		object: "chat.completion.chunk",
		created: 0,
		model,
	};
	const chunk = (choice: ChunkChoice) => ({ ...base, choices: [choice] });
	const chunks: unknown[] = [
		chunk({
			index: 0,
			delta: { role: "assistant", content: "" },
			finish_reason: null,
		}),
	];
	if (turn.reasoning) {
		chunks.push(
			chunk({
				index: 0,
				delta: { reasoning_content: turn.reasoning },
				finish_reason: null,
			}),
		);
	}
	if (turn.text) {
		chunks.push(
			chunk({ index: 0, delta: { content: turn.text }, finish_reason: null }),
		);
	}
	for (const [index, call] of (turn.toolCalls ?? []).entries()) {
		const args = JSON.stringify(call.input);
		const split = Math.ceil(args.length / 2);
		chunks.push(
			chunk({
				index: 0,
				delta: {
					tool_calls: [
						{
							index,
							id: `call_eval_${turnIndex}_${index}`,
							type: "function",
							function: { name: call.name, arguments: args.slice(0, split) },
						},
					],
				},
				finish_reason: null,
			}),
			chunk({
				index: 0,
				delta: {
					tool_calls: [{ index, function: { arguments: args.slice(split) } }],
				},
				finish_reason: null,
			}),
		);
	}
	chunks.push(
		chunk({
			index: 0,
			delta: {},
			finish_reason: turn.toolCalls?.length ? "tool_calls" : "stop",
		}),
	);
	const usage = turn.usage ?? { input: 1000, output: 100 };
	chunks.push({
		...base,
		choices: [],
		usage: {
			prompt_tokens: usage.input,
			completion_tokens: usage.output,
			total_tokens: usage.input + usage.output,
		},
	});
	return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

/** Build a whole cassette: one chat-completions entry per scripted turn. */
export function buildCassette(input: {
	baseUrl: string;
	model: string;
	turns: ScriptedTurn[];
}): VcrRecording[] {
	const { scope, path } = chatCompletionsEndpoint(input.baseUrl);
	return input.turns.map((turn, index) => ({
		scope,
		method: "POST",
		path,
		status: 200,
		response: renderTurnSse(turn, input.model, index),
		responseIsBinary: false,
		contentType: "text/event-stream",
	}));
}
