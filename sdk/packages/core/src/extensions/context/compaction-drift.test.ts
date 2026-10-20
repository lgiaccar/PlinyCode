import type { ProviderConfig } from "@plinycode/llms";
import type { MessageWithMetadata } from "@plinycode/shared";
import { estimateRequestInputTokens } from "@plinycode/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createHandlerMock = vi.fn();
vi.mock("@plinycode/llms", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@plinycode/llms")>();
	return {
		...actual,
		createHandlerAsync: (...args: unknown[]) => createHandlerMock(...args),
	};
});

import { createSessionCompactionState } from "../../session/models/session-compaction";
import {
	createCompactionStateAwarePrepareTurn,
	createContextCompactionPrepareTurn,
	resolveAutoMessageTargetTokens,
	resolvePreserveRecentTokens,
} from "./compaction";
import {
	buildSummaryMessage,
	type CompactionSummarySection,
	carrySummarySections,
	getCompactionSummaryMetadata,
	isTurnStartMessage,
	mergeUnique,
	SUMMARY_SECTIONS_CHAR_LIMIT,
	selectSectionsToCondense,
	stripHostRenderedSections,
} from "./compaction-shared";
import { extractLastFailure, extractTodoList } from "./summary-state";

const noFiles = { readFiles: [], modifiedFiles: [] };

function streamChunks(chunks: Array<Record<string, unknown>>) {
	return (async function* () {
		for (const chunk of chunks) {
			yield chunk;
		}
	})();
}

function summarizerReturning(text: string) {
	createHandlerMock.mockReturnValue({
		createMessage: vi.fn(() =>
			streamChunks([
				{ type: "text", id: "s", text },
				{ type: "done", id: "s", success: true },
			]),
		),
	});
}

function typed(text: string): MessageWithMetadata {
	return {
		role: "user",
		content: `<user_input mode="act">${text}</user_input>`,
	};
}

function reminder(text: string): MessageWithMetadata {
	return {
		role: "user",
		content: text,
		metadata: { userRunSpan: 0, displayRole: "system" },
	};
}

function toolPair(
	id: string,
	name: string,
	input: Record<string, unknown>,
	output: string,
): MessageWithMetadata[] {
	return [
		{
			role: "assistant",
			content: [{ type: "tool_use", id, name, input }],
		},
		{
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: id, name, content: output },
			],
		},
	];
}

describe("target and preserve floors", () => {
	it("keeps a share of the message budget when the overhead eats the target", () => {
		// 22k of overhead on a 92k budget: the old code left max(1, 46k - 22k)
		// only when five "pairs" had not forced the 0.5 target; with it the
		// target collapsed to 1 token.
		const messageTrigger = 82_800 - 22_000;
		expect(
			resolveAutoMessageTargetTokens({
				requestTargetTokens: 23_000,
				overheadTokens: 22_000,
				messageTriggerTokens: messageTrigger,
			}),
		).toBe(Math.floor(messageTrigger * 0.35));
	});

	it("uses the requested target when it is inside the floor and the ceiling", () => {
		expect(
			resolveAutoMessageTargetTokens({
				requestTargetTokens: 50,
				overheadTokens: 19,
				messageTriggerTokens: 71,
			}),
		).toBe(31);
	});

	it("never exceeds what fits under the trigger", () => {
		expect(
			resolveAutoMessageTargetTokens({
				requestTargetTokens: 1_000,
				overheadTokens: 0,
				messageTriggerTokens: 100,
			}),
		).toBe(99);
	});

	it("preserves at least the floor, never more than the target, and honours a configured zero", () => {
		expect(resolvePreserveRecentTokens(undefined, 40_000)).toBe(20_000);
		expect(resolvePreserveRecentTokens(undefined, 8_000)).toBe(6_000);
		expect(resolvePreserveRecentTokens(undefined, 1_000)).toBe(1_000);
		expect(resolvePreserveRecentTokens(0, 40_000)).toBe(0);
		expect(resolvePreserveRecentTokens(1, 40_000)).toBe(1);
	});
});

describe("typed turns", () => {
	it("does not count the runtime's reminders and notices as turn starts", () => {
		expect(isTurnStartMessage(typed("do it"))).toBe(true);
		expect(
			isTurnStartMessage(
				reminder("[SYSTEM] Your last message reads as unfinished"),
			),
		).toBe(false);
		expect(
			isTurnStartMessage({
				role: "user",
				content:
					"This is the 3rd call to `run_commands` with the same arguments",
				metadata: { kind: "loop_detection_notice" },
			}),
		).toBe(false);
		expect(
			isTurnStartMessage({
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "t", name: "x", content: "ok" },
				],
			}),
		).toBe(false);
	});
});

describe("summary state", () => {
	it("renders the newest task list the model wrote, in any of the tool's shapes", () => {
		const messages: MessageWithMetadata[] = [
			typed("do the five phases"),
			...toolPair(
				"t1",
				"update_todo_list",
				{ todos: [{ content: "phase 1", status: "completed" }] },
				"ok",
			),
			...toolPair(
				"t2",
				"update_todo_list",
				{
					todos: [
						{ content: "phase 1", status: "completed" },
						{ content: "phase 2", status: "in_progress" },
						{ content: "phase 3" },
					],
				},
				"ok",
			),
		];
		expect(extractTodoList(messages)).toBe(
			"- [x] phase 1\n- [>] phase 2\n- [ ] phase 3",
		);
		expect(
			extractTodoList([
				...toolPair(
					"t3",
					"update_todo_list",
					{ todos: "- [x] a\n- [ ] b" },
					"ok",
				),
			]),
		).toBe("- [x] a\n- [ ] b");
		expect(extractTodoList([typed("nothing")])).toBeUndefined();
	});

	it("carries the newest failed command with the head of its result", () => {
		const messages: MessageWithMetadata[] = [
			typed("build it"),
			...toolPair(
				"t1",
				"run_commands",
				{ commands: ["git status"] },
				JSON.stringify([
					{ query: "git status", result: "fine", success: true },
				]),
			),
			...toolPair(
				"t2",
				"run_commands",
				{ commands: ["cmake --build ."] },
				JSON.stringify([
					{
						query: "cmake --build .",
						result: `error C2039: 'foo': is not a member ${"x".repeat(2_000)}`,
						error: "Command exited with code 1",
						success: false,
					},
				]),
			),
			...toolPair(
				"t3",
				"read_files",
				{ files: [{ path: "a.ts" }] },
				"contents",
			),
		];
		const failure = extractLastFailure(messages);
		expect(failure).toContain('run_commands({"commands":["cmake --build ."]})');
		expect(failure).toContain("error C2039");
		expect(failure).toContain("...[truncated");
		expect(failure?.length).toBeLessThan(1_400);
		expect(
			extractLastFailure([
				typed("x"),
				...toolPair("t4", "read_files", {}, "ok"),
			]),
		).toBeUndefined();
	});

	it("treats a provider-flagged error result as a failure", () => {
		const messages: MessageWithMetadata[] = [
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "e1",
						name: "editor",
						input: { path: "a.ts" },
					},
				],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "e1",
						name: "editor",
						content: "old_text not found",
						is_error: true,
					},
				],
			},
		];
		expect(extractLastFailure(messages)).toContain("old_text not found");
	});
});

describe("summary layout", () => {
	it("renders the pinned request, task list, progress, earlier sections, failure and files", () => {
		const message = buildSummaryMessage({
			summary: "## State\n- Done: phase 1\n\n## Next\nphase 2",
			fileOps: { readFiles: ["D:\\x\\a.h"], modifiedFiles: [] },
			tokensBefore: 100,
			userRunSpan: 1,
			originalRequest: "execute the plan in PLAN.md",
			sections: [
				{
					span: 1,
					iteration: 12,
					foldedMessages: 30,
					text: "- did a",
					generatedAt: 1,
				},
			],
			todo: "- [x] a\n- [ ] b",
			lastFailure: "run_commands(...)\nerror: boom",
		});
		const text = (message.content as Array<{ text: string }>)[0].text;
		const order = [
			"## Original request",
			"## Task list",
			"## Progress",
			"## Earlier summaries",
			"### Span 1 (iteration 12, 30 messages)",
			"## Last failure",
			"## Files",
			"take precedence over the request above",
		].map((marker) => text.indexOf(marker));
		expect(order.every((index) => index >= 0)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		const metadata = getCompactionSummaryMetadata(message);
		expect(metadata).toMatchObject({
			schemaVersion: 2,
			originalRequest: "execute the plan in PLAN.md",
			summary: "## State\n- Done: phase 1\n\n## Next\nphase 2",
			todo: "- [x] a\n- [ ] b",
			lastFailure: "run_commands(...)\nerror: boom",
		});
		expect(metadata?.sections).toHaveLength(1);
	});

	it("leaves the request out of the text while the prompt is still in the request", () => {
		const message = buildSummaryMessage({
			summary: "## State\n- Done: nothing",
			fileOps: noFiles,
			tokensBefore: 1,
			userRunSpan: 1,
			originalRequest: "the prompt",
			renderOriginalRequest: false,
		});
		const text = (message.content as Array<{ text: string }>)[0].text;
		expect(text).not.toContain("## Original request");
		expect(getCompactionSummaryMetadata(message)?.originalRequest).toBe(
			"the prompt",
		);
	});

	it("carries the previous summary's sections and its own note as the newest section", () => {
		const first = buildSummaryMessage({
			summary: "note one",
			fileOps: noFiles,
			tokensBefore: 1,
			userRunSpan: 1,
		});
		const carried = carrySummarySections(getCompactionSummaryMetadata(first));
		expect(carried.map((section) => section.text)).toEqual(["note one"]);
		const second = buildSummaryMessage({
			summary: "note two",
			fileOps: noFiles,
			tokensBefore: 1,
			userRunSpan: 1,
			sections: carried,
		});
		const carriedAgain = carrySummarySections(
			getCompactionSummaryMetadata(second),
		);
		expect(carriedAgain.map((section) => [section.span, section.text])).toEqual(
			[
				[1, "note one"],
				[2, "note two"],
			],
		);
	});

	it("reads an old summary without sections as one section", () => {
		const legacy: MessageWithMetadata = {
			role: "user",
			content: [{ type: "text", text: "Context summary:\n\n## Goal\nold" }],
			metadata: {
				kind: "compaction_summary",
				displayRole: "system",
				userRunSpan: 1,
				summary: "## Goal\nold",
				details: noFiles,
				tokensBefore: 1,
				generatedAt: 1,
			},
		};
		expect(carrySummarySections(getCompactionSummaryMetadata(legacy))).toEqual([
			{ span: 1, foldedMessages: 0, text: "## Goal\nold", generatedAt: 1 },
		]);
	});

	it("condenses the oldest sections once they outgrow the limit, never the newest two", () => {
		const sections: CompactionSummarySection[] = [1, 2, 3, 4, 5].map(
			(span) => ({
				span,
				foldedMessages: 10,
				text: `s${span} ${"x".repeat(SUMMARY_SECTIONS_CHAR_LIMIT / 4)}`,
				generatedAt: span,
			}),
		);
		const { condense, keep } = selectSectionsToCondense(sections);
		expect(condense.map((section) => section.span)).toEqual([1, 2, 3]);
		expect(keep.map((section) => section.span)).toEqual([4, 5]);
		expect(selectSectionsToCondense(sections.slice(0, 2)).condense).toEqual([]);
	});

	it("strips the sections the host renders itself from the model's note", () => {
		expect(
			stripHostRenderedSections(
				"## Goal\nfix it\n\n## State\n- Done: x\n\n## Files\nRead: a\n\n## Next\n- y",
			),
		).toBe("## State\n- Done: x\n\n## Next\n- y");
	});

	it("merges one file under two spellings of its Windows path", () => {
		expect(
			mergeUnique(["D:\\dev\\a.h"], ["d:/dev/a.h", "d:\\dev\\b.h"]),
		).toEqual(["D:\\dev\\a.h", "d:\\dev\\b.h"]);
	});
});

describe("compaction that does not pay for itself", () => {
	const systemPrompt = "You are helpful.";
	const providerConfig = {
		providerId: "anthropic",
		modelId: "mock-model",
	} as ProviderConfig;

	beforeEach(() => {
		createHandlerMock.mockReset();
	});

	function prepare(options: {
		strategy: "agentic" | "basic";
		log?: ReturnType<typeof vi.fn>;
	}) {
		return createContextCompactionPrepareTurn({
			providerId: "anthropic",
			modelId: "mock-model",
			providerConfig,
			compaction: { enabled: true, strategy: options.strategy },
			logger: { debug: vi.fn(), log: options.log ?? vi.fn() },
		});
	}

	it("rests after a summary that leaves the request as large and over the trigger", async () => {
		// One typed prompt, then one huge tool loop that is all current turn:
		// the summary folds nothing useful and the tail stays over the trigger.
		const big = "w".repeat(9_000);
		const messages: MessageWithMetadata[] = [
			typed("do the thing"),
			...toolPair("t1", "read_files", { files: [{ path: "a.ts" }] }, big),
			...toolPair("t2", "read_files", { files: [{ path: "b.ts" }] }, big),
			...toolPair("t3", "read_files", { files: [{ path: "c.ts" }] }, big),
		];
		// The summarizer answers with as much text as it folded.
		summarizerReturning(`## State\n${"s".repeat(9_000)}`);
		const log = vi.fn();
		const emitStatusNotice = vi.fn();
		const prepareTurn = prepare({ strategy: "agentic", log });
		const maxInputTokens = Math.floor(
			estimateRequestInputTokens({ systemPrompt, messages, tools: [] }) * 0.95,
		);
		const call = (iteration: number) =>
			prepareTurn?.({
				agentId: "agent-1",
				conversationId: "conv-1",
				parentAgentId: null,
				iteration,
				abortSignal: new AbortController().signal,
				systemPrompt,
				tools: [],
				messages,
				apiMessages: messages,
				model: {
					id: "mock-model",
					provider: "anthropic",
					info: { id: "mock-model", maxInputTokens },
				},
				emitStatusNotice,
			});
		const result = await call(1);
		const skipped = emitStatusNotice.mock.calls.find(
			([name]) => name === "auto-compaction-skipped",
		);
		if (result === undefined) {
			expect(skipped?.[1]).toMatchObject({
				skipReason: "not_smaller",
				diagnostics: expect.objectContaining({ cooldownUntilIteration: 7 }),
			});
			const calls = createHandlerMock.mock.calls.length;
			await call(2);
			expect(createHandlerMock.mock.calls.length).toBe(calls);
		} else {
			// Basic trimming inside the turn made it smaller: that is accepted.
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("trimming inside the latest turn"),
				expect.anything(),
			);
		}
	});
});

describe("re-compaction sizes the pruned request", () => {
	it("hands the compacted projection through pruneForApi before sizing it", async () => {
		const projection: MessageWithMetadata[] = [
			buildSummaryMessage({
				summary: "## State\n- Done: a",
				fileOps: noFiles,
				tokensBefore: 1,
				userRunSpan: 1,
			}),
			{ role: "assistant", content: "tail" },
		];
		const source: MessageWithMetadata[] = [
			{ role: "user", content: "task" },
			{ role: "assistant", content: "folded" },
		];
		const state = createSessionCompactionState({
			sourceMessages: source,
			compactedMessages: projection,
			conversationId: "conv-1",
		});
		const pruned: MessageWithMetadata[] = [
			{ role: "assistant", content: "pruned" },
		];
		const pruneForApi = vi.fn(async () => pruned);
		const compact = vi.fn(async () => undefined);
		const prepareTurn = createCompactionStateAwarePrepareTurn({
			compact,
			getState: () => state,
		});
		await prepareTurn({
			agentId: "agent-1",
			conversationId: "conv-1",
			parentAgentId: null,
			iteration: 3,
			abortSignal: new AbortController().signal,
			systemPrompt: "sys",
			tools: [],
			messages: source,
			apiMessages: source,
			model: { id: "m", provider: "p" },
			pruneForApi,
		});
		expect(pruneForApi).toHaveBeenCalledTimes(1);
		expect(compact).toHaveBeenCalledWith(
			expect.objectContaining({ apiMessages: pruned }),
		);
	});
});
