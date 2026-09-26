import { describe, expect, it } from "vitest";
import { toSafeToolCallId, withSafeToolCallIds } from "./tool-call-ids";

const BEDROCK_TOOL_USE_ID = /^[a-zA-Z0-9-]+$/;

describe("toSafeToolCallId", () => {
	it("keeps ids that are already safe", () => {
		expect(toSafeToolCallId("abc-123-XYZ")).toBe("abc-123-XYZ");
	});

	it.each([
		"call_abc123",
		"toolu_01AbCdEf",
		"functions.read_file:0",
		"tool_V1StGXR8_Z5jdHi6B-myT",
		"fc_123|call_456",
		"a".repeat(80),
		"___",
	])("rewrites %j to the Bedrock tool_use.id alphabet", (id) => {
		const safe = toSafeToolCallId(id);
		expect(safe).toMatch(BEDROCK_TOOL_USE_ID);
		expect(safe.length).toBeLessThanOrEqual(64);
		expect(toSafeToolCallId(id)).toBe(safe);
	});

	it("keeps ids distinct when only the invalid characters differ", () => {
		expect(toSafeToolCallId("call_1")).not.toBe(toSafeToolCallId("call.1"));
	});
});

describe("withSafeToolCallIds", () => {
	it("rewrites a tool call and its result to the same id", () => {
		const body = {
			model: "global.anthropic.claude-sonnet-5",
			messages: [
				{ role: "user", content: "hi" },
				{
					role: "assistant",
					content: "",
					tool_calls: [
						{
							id: "functions.read_file:0",
							type: "function",
							function: { name: "read_file", arguments: "{}" },
						},
					],
				},
				{
					role: "tool",
					tool_call_id: "functions.read_file:0",
					content: "ok",
				},
			],
		};

		const result = withSafeToolCallIds(body) as typeof body;
		const callId = result.messages[1].tool_calls?.[0].id;
		expect(callId).toMatch(BEDROCK_TOOL_USE_ID);
		expect(result.messages[2].tool_call_id).toBe(callId);
		expect(result.messages[1].tool_calls?.[0].function).toEqual({
			name: "read_file",
			arguments: "{}",
		});
		// The input body is not mutated.
		expect(body.messages[1].tool_calls?.[0].id).toBe("functions.read_file:0");
	});

	it("returns the same body when every id is already safe", () => {
		const body = {
			messages: [
				{ role: "assistant", tool_calls: [{ id: "abc-1" }] },
				{ role: "tool", tool_call_id: "abc-1", content: "ok" },
			],
		};
		expect(withSafeToolCallIds(body)).toBe(body);
	});

	it("ignores bodies without messages", () => {
		const body = { input: "x" };
		expect(withSafeToolCallIds(body)).toBe(body);
	});
});
