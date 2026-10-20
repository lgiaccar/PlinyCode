import { describe, expect, it } from "vitest";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	extractLatestUserRequest,
	extractOriginalRequest,
} from "./compaction-shared";

const noFiles = { readFiles: [], modifiedFiles: [] };

describe("summary goal anchoring", () => {
	it("finds the newest typed prompt, skipping tool results and summaries", () => {
		const text = extractLatestUserRequest([
			{ role: "user", content: "first request" },
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{
				role: "user",
				content: [{ type: "text", text: "fix the 4 failing tests" }],
			},
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						name: "run",
						tool_use_id: "t1",
						content: "done",
					},
				],
			},
		]);
		expect(text).toBe("fix the 4 failing tests");
	});

	it("returns undefined when the user typed nothing", () => {
		expect(
			extractLatestUserRequest([
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			]),
		).toBeUndefined();
	});

	it("puts the original request before the earlier summaries and keeps them for reference only", () => {
		const request = buildSummaryRequest({
			previousSummary: "### Span 1\nFix compilation error",
			conversationText: "[User]: fix the bug",
			fileOps: noFiles,
			latestUserRequest: "fix the 4 failing tests",
		});
		expect(request).toContain(
			"Original request (the goal; later user messages win):\nfix the 4 failing tests",
		);
		expect(request).toContain(
			"Earlier summaries (for reference; do not restate them)",
		);
		expect(request).toContain("Unverified");
		expect(request).not.toContain("## Goal");
		expect(request).toContain(
			"Do not write a Goal, Files or Task list section",
		);
		expect(request.indexOf("Original request (the goal")).toBeLessThan(
			request.indexOf("Earlier summaries (for reference"),
		);
	});

	it("omits the request block when there is none", () => {
		expect(
			buildSummaryRequest({ conversationText: "x", fileOps: noFiles }),
		).not.toContain("Original request (the goal");
	});

	it("skips the runtime's own user-role messages when looking for the newest request", () => {
		const text = extractLatestUserRequest([
			{
				role: "user",
				content: '<user_input mode="act">execute the plan</user_input>',
			},
			{ role: "assistant", content: [{ type: "text", text: "ok" }] },
			{
				role: "user",
				content: "[SYSTEM] Your last message reads as unfinished thinking.",
				metadata: { userRunSpan: 0, displayRole: "system" },
			},
		]);
		expect(text).toBe("execute the plan");
	});

	it("falls back to the request an earlier summary pinned once the prompt was folded", () => {
		const summary = buildSummaryMessage({
			summary: "## State\n- Done: nothing yet",
			fileOps: noFiles,
			tokensBefore: 10,
			userRunSpan: 1,
			originalRequest: "execute the plan in PLAN.md",
		});
		expect(
			extractOriginalRequest([
				summary,
				{ role: "assistant", content: [{ type: "text", text: "working" }] },
			]),
		).toBe("execute the plan in PLAN.md");
	});

	it("tells the model the user's later messages win over the summary goal", () => {
		const message = buildSummaryMessage({
			summary: "## Goal\nx",
			fileOps: noFiles,
			tokensBefore: 1,
			userRunSpan: 1,
		});
		expect(JSON.stringify(message.content)).toContain("take precedence");
	});
});
