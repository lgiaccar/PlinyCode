import type { AgentMessage, AgentMessagePart } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import {
	cutAssistantTextTail,
	DEFAULT_STALE_CONTEXT_OPTIONS,
	elideLargeInputStrings,
	elideToolResultOutput,
	measureToolOutputChars,
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

const user = (text: string, metadata?: Record<string, unknown>) =>
	message("user", [{ type: "text", text }], metadata);
const text = (value: string): AgentMessagePart => ({
	type: "text",
	text: value,
});
const toolCall = (
	id: string,
	input: unknown = {},
	toolName = "read_files",
): AgentMessagePart => ({ type: "tool-call", toolCallId: id, toolName, input });
const toolResult = (
	id: string,
	output: unknown,
	options: { isError?: boolean; toolName?: string } = {},
) =>
	message("tool", [
		{
			type: "tool-result",
			toolCallId: id,
			toolName: options.toolName ?? "read_files",
			output,
			...(options.isError ? { isError: true } : {}),
		},
	]);
const big = (chars: number, fill = "x") => fill.repeat(chars);

function resultOutput(result: AgentMessage): unknown {
	const part = result.content[0];
	return part?.type === "tool-result" ? part.output : undefined;
}

function assistantText(result: AgentMessage): string {
	return result.content
		.filter(
			(part): part is { type: "text"; text: string } => part.type === "text",
		)
		.map((part) => part.text)
		.join("");
}

/** A turn of `iterations` tool-call steps, each with a result of `resultChars`. */
function turn(
	prompt: string,
	iterations: number,
	resultChars: number,
	textChars = 10,
): AgentMessage[] {
	const out: AgentMessage[] = [user(prompt)];
	for (let step = 1; step <= iterations; step += 1) {
		const id = `${prompt}-${step}`;
		out.push(message("assistant", [text(big(textChars, "t")), toolCall(id)]));
		out.push(toolResult(id, big(resultChars)));
	}
	return out;
}

describe("pruneStaleContext: earlier turns", () => {
	it("stubs a large string tool result from an earlier turn, keeping its id and first line", () => {
		const output = `source/a.ts:12: match\n${big(48_000)}`;
		const messages = [
			user("first"),
			message("assistant", [text("reading"), toolCall("a")]),
			toolResult("a", output),
			message("assistant", [text("done")]),
			user("second"),
		];
		const result = pruneStaleContext(messages);
		const stub = resultOutput(result[2]);
		expect(typeof stub).toBe("string");
		expect(stub).toContain("read_files output elided");
		expect(stub).toContain(String(output.length));
		expect(stub).toContain('"source/a.ts:12: match"');
		expect(stub).toContain("earlier turn");
		expect((result[2].content[0] as { toolCallId: string }).toolCallId).toBe(
			"a",
		);
		// The history passed in is not mutated.
		expect(resultOutput(messages[2])).toBe(output);
	});

	it("keeps small results, error results and image results of earlier turns", () => {
		const messages = [
			user("first"),
			message("assistant", [
				toolCall("small"),
				toolCall("err"),
				toolCall("img"),
			]),
			toolResult("small", big(1_500)),
			toolResult("err", big(10_000), { isError: true }),
			toolResult("img", [
				{
					query: "a.png",
					result: [
						{ type: "image", data: big(10_000), mediaType: "image/png" },
					],
					success: true,
				},
			]),
			user("second"),
		];
		const result = pruneStaleContext(messages);
		expect(result[2]).toBe(messages[2]);
		expect(result[3]).toBe(messages[3]);
		expect(result[4]).toBe(messages[4]);
	});

	it("stubs structured entries, keeping query, success and error", () => {
		const messages = [
			user("first"),
			message("assistant", [toolCall("s", {}, "search_codebase")]),
			toolResult(
				"s",
				[
					{ query: "foo", result: big(30_000), success: true },
					{ query: "bar", result: "", error: "no matches", success: false },
				],
				{ toolName: "search_codebase" },
			),
			user("second"),
		];
		const result = pruneStaleContext(messages);
		const output = resultOutput(result[2]) as Array<Record<string, unknown>>;
		expect(output[0]).toMatchObject({ query: "foo", success: true });
		expect(output[0].result).toContain("output elided (30000 chars)");
		expect(output[1]).toMatchObject({
			query: "bar",
			error: "no matches",
			success: false,
		});
	});

	it("cuts the deliberation before a tool call to its tail, and keeps final answers whole", () => {
		const deliberation = `${big(30_000, "d")}\nNow let me read the templates.`;
		const answer = big(30_000, "a");
		const messages = [
			user("first"),
			message("assistant", [text(deliberation), toolCall("a")]),
			toolResult("a", "ok"),
			message("assistant", [{ type: "reasoning", text: "r" }, text(answer)]),
			user("second"),
		];
		const result = pruneStaleContext(messages);
		const cut = assistantText(result[1]);
		expect(cut.startsWith("[earlier deliberation cut: omitted")).toBe(true);
		expect(cut.endsWith("Now let me read the templates.")).toBe(true);
		expect(cut.length).toBeLessThan(700);
		expect(result[1].content[1]).toEqual(toolCall("a"));
		expect(result[3]).toBe(messages[3]);
	});

	it("elides the long strings of a failed tool call's input and keeps the JSON valid", () => {
		const input = { path: "d:/plan.md", new_text: big(20_000), old_text: "x" };
		const messages = [
			user("first"),
			message("assistant", [toolCall("e", input, "editor")]),
			toolResult(
				"e",
				[
					{
						query: "edit",
						result: "",
						error: "input too large",
						success: false,
					},
				],
				{
					isError: true,
					toolName: "editor",
				},
			),
			message("assistant", [
				toolCall("ok", { ...input, path: "fine.md" }, "editor"),
			]),
			toolResult("ok", "written", { toolName: "editor" }),
			user("second"),
		];
		const result = pruneStaleContext(messages);
		const elided = (result[1].content[0] as { input: Record<string, unknown> })
			.input;
		expect(elided).toEqual({
			path: "d:/plan.md",
			new_text: "<elided 20000 chars>",
			old_text: "x",
		});
		expect(JSON.parse(JSON.stringify(elided))).toEqual(elided);
		// A call that succeeded keeps its input.
		expect((result[3].content[0] as { input: unknown }).input).toEqual({
			...input,
			path: "fine.md",
		});
	});

	it("leaves the latest request, reminders and compaction summaries alone", () => {
		const reminder = user(
			"[SYSTEM] Your last message said what you would do next.",
			{
				displayRole: "system",
				userRunSpan: 0,
			},
		);
		const summary = user(`Context summary:\n\n${big(5_000)}`, {
			kind: "compaction_summary",
			displayRole: "system",
			userRunSpan: 1,
		});
		const latest = user(big(5_000));
		const messages = [user("first"), summary, reminder, latest];
		const result = pruneStaleContext(messages);
		expect(result[1]).toBe(summary);
		expect(result[2]).toBe(reminder);
		expect(result[3]).toBe(latest);
	});
});

describe("pruneStaleContext: the current turn", () => {
	it("leaves the first fifteen iterations alone, then cuts in blocks of eight", () => {
		const fifteen = turn("go", 15, 20_000);
		expect(pruneStaleContext(fifteen).every((m, i) => m === fifteen[i])).toBe(
			true,
		);

		// Sixteen iterations done, the seventeenth call being prepared: steps 1-8
		// are aged and their results middle-cut; steps 9-16 are untouched.
		const sixteen = turn("go", 16, 20_000);
		const result = pruneStaleContext(sixteen);
		for (let step = 1; step <= 16; step += 1) {
			const resultIndex = step * 2;
			const output = resultOutput(result[resultIndex]) as string;
			if (step <= 8) {
				expect(output).toContain("read_files output middle cut: omitted");
				expect(output.length).toBeLessThan(4_000);
			} else {
				expect(result[resultIndex]).toBe(sixteen[resultIndex]);
			}
		}

		// Twenty-three iterations still cut only the first block; twenty-four cut two.
		const twentyThree = turn("go", 23, 20_000);
		const soon = pruneStaleContext(twentyThree);
		expect(soon[9 * 2]).toBe(twentyThree[9 * 2]);
		const twentyFour = turn("go", 24, 20_000);
		const later = pruneStaleContext(twentyFour);
		expect(resultOutput(later[16 * 2]) as string).toContain("middle cut");
		expect(later[17 * 2]).toBe(twentyFour[17 * 2]);
	});

	it("keeps aged in-turn results under the size limit, and cuts aged long assistant text", () => {
		const messages = turn("go", 16, 1_000, 7_000);
		const result = pruneStaleContext(messages);
		expect(result[2]).toBe(messages[2]);
		expect(assistantText(result[1])).toContain("[earlier deliberation cut");
		expect(assistantText(result[16 * 2 - 1])).toBe(
			assistantText(messages[16 * 2 - 1]),
		);
	});

	it("is deterministic and only changes a block once as the turn grows", () => {
		const a = turn("go", 20, 20_000);
		const first = pruneStaleContext(a);
		const again = pruneStaleContext(a);
		expect(JSON.stringify(first)).toBe(JSON.stringify(again));

		const b = [
			...a,
			message("assistant", [text("t"), toolCall("extra")]),
			toolResult("extra", big(20_000)),
		];
		const next = pruneStaleContext(b);
		// Adding iteration 21 changes nothing that iteration 20 had already settled.
		for (let index = 0; index < a.length; index += 1) {
			expect(JSON.stringify(next[index])).toBe(JSON.stringify(first[index]));
		}
	});

	it("treats a history with no typed prompt as one current turn", () => {
		const messages = turn("go", 3, 20_000).slice(1);
		expect(pruneStaleContext(messages).every((m, i) => m === messages[i])).toBe(
			true,
		);
	});
});

describe("stale-context helpers", () => {
	it("measures strings inside structured outputs and ignores images", () => {
		expect(measureToolOutputChars("abc")).toBe(3);
		expect(
			measureToolOutputChars([
				{ query: "q", result: "rrrr", success: true },
				{ type: "image", data: big(100), mediaType: "image/png" },
				{ type: "text", text: "tt" },
			]),
		).toBe(4 + 2);
	});

	it("keeps a file entry's path when eliding it", () => {
		const out = elideToolResultOutput(
			[{ type: "file", path: "a.ts", content: big(100) }],
			"read_files",
		) as Array<Record<string, unknown>>;
		expect(out[0].path).toBe("a.ts");
		expect(out[0].content).toContain("file content elided (100 chars)");
	});

	it("moves the tail cut forward to a line break when one is near", () => {
		const value = `${big(1_000)}\n${big(500, "y")}`;
		const cut = cutAssistantTextTail(value, 600);
		expect(cut.endsWith(`\n${big(500, "y")}`)).toBe(true);
		expect(cut).not.toContain("x");
	});

	it("elides nested strings and leaves numbers and short strings", () => {
		expect(
			elideLargeInputStrings({ a: big(10), n: 3, list: [big(10), "s"] }, 5),
		).toEqual({
			a: "<elided 10 chars>",
			n: 3,
			list: ["<elided 10 chars>", "s"],
		});
	});

	it("resolves options from defaults, ignoring bad overrides", () => {
		expect(resolveStaleContextOptions()).toEqual(DEFAULT_STALE_CONTEXT_OPTIONS);
		expect(
			resolveStaleContextOptions({
				keepRecentIterations: 4,
				priorTurnToolResultChars: -1,
			}).keepRecentIterations,
		).toBe(4);
		expect(
			resolveStaleContextOptions({ priorTurnToolResultChars: -1 })
				.priorTurnToolResultChars,
		).toBe(DEFAULT_STALE_CONTEXT_OPTIONS.priorTurnToolResultChars);
	});
});
