import type { AgentMessage, AgentMessagePart } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import { dropPriorTurnReasoning } from "./prior-turn-reasoning";

let nextId = 0;
function message(
	role: AgentMessage["role"],
	content: AgentMessagePart[],
	metadata?: Record<string, unknown>,
): AgentMessage {
	nextId += 1;
	return { id: `m${nextId}`, role, content, createdAt: nextId, metadata };
}

const user = (text: string) => message("user", [{ type: "text", text }]);
const reasoning = (text: string, metadata?: unknown): AgentMessagePart => ({
	type: "reasoning",
	text,
	...(metadata ? { metadata } : {}),
});
const toolCall = (id: string): AgentMessagePart => ({
	type: "tool-call",
	toolCallId: id,
	toolName: "read_files",
	input: {},
});
const toolResult = (id: string) =>
	message("tool", [
		{
			type: "tool-result",
			toolCallId: id,
			toolName: "read_files",
			output: "x",
		},
	]);

describe("dropPriorTurnReasoning", () => {
	it("drops reasoning from earlier turns and keeps the current turn's", () => {
		const messages = [
			user("first"),
			message("assistant", [reasoning("old thought"), toolCall("a")]),
			toolResult("a"),
			message("assistant", [
				reasoning("old thought 2"),
				{ type: "text", text: "done" },
			]),
			user("second"),
			message("assistant", [reasoning("current thought"), toolCall("b")]),
			toolResult("b"),
		];

		const result = dropPriorTurnReasoning(messages);
		const serialized = JSON.stringify(result);

		expect(serialized).not.toContain("old thought");
		expect(serialized).toContain("current thought");
		expect(result[1]?.content).toEqual([toolCall("a")]);
		expect(result[3]?.content).toEqual([{ type: "text", text: "done" }]);
		// History passed in is not mutated.
		expect(JSON.stringify(messages)).toContain("old thought");
	});

	it("does not treat injected reminders as a new turn", () => {
		const messages = [
			user("task"),
			message("assistant", [reasoning("keep me"), toolCall("a")]),
			toolResult("a"),
			message("user", [{ type: "text", text: "[SYSTEM] keep going" }], {
				userRunSpan: 0,
				displayRole: "system",
			}),
		];

		expect(JSON.stringify(dropPriorTurnReasoning(messages))).toContain(
			"keep me",
		);
	});

	it("keeps signed reasoning from earlier turns", () => {
		const messages = [
			user("first"),
			message("assistant", [
				reasoning("signed thought", { signature: "sig" }),
				{ type: "text", text: "answer" },
			]),
			user("second"),
		];

		expect(JSON.stringify(dropPriorTurnReasoning(messages))).toContain(
			"signed thought",
		);
	});

	it("strips inline <think> blocks from earlier assistant text", () => {
		const messages = [
			user("first"),
			message("assistant", [
				{
					type: "text",
					text: "<think>long private trace</think>\nThe answer.",
				},
			]),
			message("assistant", [
				{ type: "text", text: "<think>only thinking</think>" },
			]),
			user("second"),
		];

		const result = dropPriorTurnReasoning(messages);

		expect(result).toHaveLength(3);
		expect(result[1]?.content).toEqual([{ type: "text", text: "The answer." }]);
	});

	it("returns messages unchanged when there is no earlier turn", () => {
		const messages = [
			user("only"),
			message("assistant", [reasoning("thinking"), toolCall("a")]),
		];

		expect(dropPriorTurnReasoning(messages)).toEqual(messages);
	});
});
