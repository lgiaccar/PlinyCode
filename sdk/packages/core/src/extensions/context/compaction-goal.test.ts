import { describe, expect, it } from "vitest";
import {
	buildSummaryMessage,
	buildSummaryRequest,
	extractLatestUserRequest,
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

	it("puts the newest request in the summary request and marks the old summary stale", () => {
		const request = buildSummaryRequest({
			previousSummary: "## Goal\nFix compilation error",
			conversationText: "[User]: fix the bug",
			fileOps: noFiles,
			latestUserRequest: "fix the 4 failing tests",
		});
		expect(request).toContain("Newest user request:\nfix the 4 failing tests");
		expect(request).toContain("Previous summary (may be stale");
		expect(request).toContain("Unverified");
		expect(request.indexOf("Newest user request")).toBeLessThan(
			request.indexOf("Previous summary"),
		);
	});

	it("omits the newest-request block when there is none", () => {
		expect(
			buildSummaryRequest({ conversationText: "x", fileOps: noFiles }),
		).not.toContain("Newest user request:");
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
