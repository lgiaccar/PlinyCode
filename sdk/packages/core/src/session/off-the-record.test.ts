import type { AgentMessage } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import {
	dropOffTheRecordTurns,
	isOffTheRecordMessage,
	isOffTheRecordTurnActive,
} from "./off-the-record";

function message(
	id: string,
	role: AgentMessage["role"],
	text: string,
	metadata?: Record<string, unknown>,
): AgentMessage {
	return {
		id,
		role,
		content: [{ type: "text", text }],
		createdAt: 1,
		...(metadata ? { metadata } : {}),
	};
}

function toolCall(id: string, callId: string): AgentMessage {
	return {
		id,
		role: "assistant",
		content: [
			{
				type: "tool-call",
				toolCallId: callId,
				toolName: "read_files",
				input: { files: [{ path: "a.ts" }] },
			},
		],
		createdAt: 1,
	};
}

function toolResult(id: string, callId: string): AgentMessage {
	return {
		id,
		role: "tool",
		content: [
			{
				type: "tool-result",
				toolCallId: callId,
				toolName: "read_files",
				output: "file contents",
			},
		],
		createdAt: 1,
	};
}

const OFF = { offTheRecord: true };

const ids = (messages: readonly AgentMessage[]) => messages.map((m) => m.id);

describe("off-the-record turns", () => {
	const transcript: AgentMessage[] = [
		message("u1", "user", "build the parser"),
		message("a1", "assistant", "done"),
		message("u2", "user", "side: what does lexer.ts do?", OFF),
		toolCall("a2", "t1"),
		toolResult("r2", "t1"),
		message("a2b", "assistant", "it tokenizes"),
		message("n2", "user", "loop notice", { kind: "loop_detection_notice" }),
		message("u3", "user", "now add tests"),
		message("a3", "assistant", "added"),
	];

	it("recognizes the message that starts one", () => {
		expect(isOffTheRecordMessage(transcript[2])).toBe(true);
		expect(isOffTheRecordMessage(transcript[0])).toBe(false);
		expect(isOffTheRecordMessage({ ...transcript[3], metadata: OFF })).toBe(
			false,
		);
	});

	it("drops the whole turn, tool calls and notices included, up to the next user run", () => {
		expect(ids(dropOffTheRecordTurns(transcript))).toEqual([
			"u1",
			"a1",
			"u3",
			"a3",
		]);
	});

	it("keeps the turn being answered when asked to", () => {
		const during = transcript.slice(0, 5);
		expect(
			ids(dropOffTheRecordTurns(during, { keepCurrentTurn: true })),
		).toEqual(["u1", "a1", "u2", "a2", "r2"]);
		expect(ids(dropOffTheRecordTurns(during))).toEqual(["u1", "a1"]);
		// Once a normal turn follows, the side question goes too.
		expect(
			ids(dropOffTheRecordTurns(transcript, { keepCurrentTurn: true })),
		).toEqual(["u1", "a1", "u3", "a3"]);
	});

	it("drops consecutive side questions and leaves a transcript without any unchanged", () => {
		const twoSides = [
			message("u1", "user", "task"),
			message("s1", "user", "side one", OFF),
			message("s1a", "assistant", "answer one"),
			message("s2", "user", "side two", OFF),
			message("s2a", "assistant", "answer two"),
			message("u2", "user", "next"),
		];
		expect(ids(dropOffTheRecordTurns(twoSides))).toEqual(["u1", "u2"]);
		const plain = [message("u1", "user", "a"), message("a1", "assistant", "b")];
		expect(dropOffTheRecordTurns(plain)).toEqual(plain);
	});

	it("tells whether the newest turn is off the record", () => {
		expect(isOffTheRecordTurnActive(transcript.slice(0, 4))).toBe(true);
		// A synthetic notice is not a new user run.
		expect(isOffTheRecordTurnActive(transcript.slice(0, 7))).toBe(true);
		expect(isOffTheRecordTurnActive(transcript)).toBe(false);
		expect(isOffTheRecordTurnActive([])).toBe(false);
	});
});
