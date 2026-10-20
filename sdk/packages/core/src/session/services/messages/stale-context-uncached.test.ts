import type { AgentMessage, AgentMessagePart } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import {
	cutAssistantTextMiddle,
	pruneStaleContext,
	resolveStaleContextOptions,
} from "./stale-context";

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
const text = (value: string): AgentMessagePart => ({
	type: "text",
	text: value,
});
const toolCall = (id: string): AgentMessagePart => ({
	type: "tool-call",
	toolCallId: id,
	toolName: "read_files",
	input: {},
});
const toolResult = (id: string, output: unknown) =>
	message("tool", [
		{ type: "tool-result", toolCallId: id, toolName: "read_files", output },
	]);
const big = (chars: number, fill = "x") => fill.repeat(chars);

function assistantText(result: AgentMessage): string {
	return result.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
}

function resultOutput(result: AgentMessage): unknown {
	const part = result.content[0];
	return part?.type === "tool-result" ? part.output : undefined;
}

/** A turn of `iterations` steps; step `n` writes `textChars(n)` chars before its call. */
function turn(
	iterations: number,
	resultChars: number,
	textChars: (step: number) => number = () => 10,
): AgentMessage[] {
	const out: AgentMessage[] = [user("go")];
	for (let step = 1; step <= iterations; step += 1) {
		const id = `go-${step}`;
		out.push(
			message("assistant", [text(big(textChars(step), "t")), toolCall(id)]),
		);
		out.push(toolResult(id, big(resultChars)));
	}
	return out;
}

const uncached = resolveStaleContextOptions(undefined, { promptCache: false });

describe("resolveStaleContextOptions: prompt cache", () => {
	it("keeps the block scheme for a cached model and when the environment is unknown", () => {
		expect(resolveStaleContextOptions().mode).toBe("cached");
		expect(
			resolveStaleContextOptions(undefined, { promptCache: true }).mode,
		).toBe("cached");
		expect(resolveStaleContextOptions().keepRecentIterations).toBe(8);
	});

	it("ages immediately for a model without a prompt cache", () => {
		expect(uncached.mode).toBe("uncached");
		expect(uncached.keepRecentIterations).toBe(2);
		expect(uncached.iterationBlockSize).toBe(1);
	});

	it("lets promptCacheAware override the environment, and keeps a resolved mode", () => {
		expect(
			resolveStaleContextOptions(
				{ promptCacheAware: true },
				{ promptCache: false },
			).mode,
		).toBe("cached");
		expect(
			resolveStaleContextOptions(
				{ promptCacheAware: false },
				{ promptCache: true },
			).mode,
		).toBe("uncached");
		expect(resolveStaleContextOptions(uncached).mode).toBe("uncached");
		expect(resolveStaleContextOptions(uncached).iterationBlockSize).toBe(1);
	});
});

describe("pruneStaleContext: no prompt cache", () => {
	it("cuts a monologue before a tool call to head and tail once two newer calls exist", () => {
		// Step 1 wrote 72k chars of deliberation; steps 2 and 3 followed.
		const messages = turn(3, 100, (step) => (step === 1 ? 72_000 : 10));
		const result = pruneStaleContext(messages, uncached);
		const cut = assistantText(result[1]);
		expect(cut).toContain("[deliberation middle cut: omitted");
		expect(cut.length).toBeLessThan(2_400);
		expect(cut.startsWith(big(100, "t"))).toBe(true);
		// The newest two iterations stay whole.
		expect(result[3]).toBe(messages[3]);
		expect(result[5]).toBe(messages[5]);
	});

	it("leaves the newest two iterations whole however long they are", () => {
		const messages = turn(2, 100, () => 72_000);
		const result = pruneStaleContext(messages, uncached);
		expect(result.every((m, i) => m === messages[i])).toBe(true);
	});

	it("middle-cuts a large result from the third newest iteration on", () => {
		const messages = turn(4, 20_000);
		const result = pruneStaleContext(messages, uncached);
		expect(resultOutput(result[2]) as string).toContain("middle cut");
		expect(resultOutput(result[4]) as string).toContain("middle cut");
		expect(result[6]).toBe(messages[6]);
		expect(result[8]).toBe(messages[8]);
	});

	it("keeps the block scheme for the same history on a cached model", () => {
		const messages = turn(4, 20_000, (step) => (step === 1 ? 72_000 : 10));
		const result = pruneStaleContext(messages);
		expect(result.every((m, i) => m === messages[i])).toBe(true);
	});

	it("keeps a final answer whole and cuts a prior turn's deliberation to its tail as before", () => {
		const messages = [
			user("first"),
			message("assistant", [text(big(9_000, "a")), toolCall("a1")]),
			toolResult("a1", "ok"),
			message("assistant", [text(big(9_000, "f"))]),
			user("second"),
			message("assistant", [text("working"), toolCall("b1")]),
			toolResult("b1", "ok"),
		];
		const result = pruneStaleContext(messages, uncached);
		expect(assistantText(result[1])).toContain("[earlier deliberation cut");
		expect(assistantText(result[1])).not.toContain("middle cut");
		expect(result[3]).toBe(messages[3]);
	});
});

describe("cutAssistantTextMiddle", () => {
	it("keeps the head and the tail and says how much was omitted", () => {
		const cut = cutAssistantTextMiddle(
			`${big(3_000, "h")}\n${big(3_000, "t")}`,
			1_000,
			500,
		);
		expect(cut.startsWith(big(1_000, "h"))).toBe(true);
		expect(cut.endsWith(big(500, "t"))).toBe(true);
		expect(cut).toContain("[deliberation middle cut: omitted 4501 chars]");
	});

	it("returns short text as it is", () => {
		expect(cutAssistantTextMiddle("short", 1_000, 500)).toBe("short");
	});
});
