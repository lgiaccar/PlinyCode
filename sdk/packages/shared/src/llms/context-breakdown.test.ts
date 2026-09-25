import { describe, expect, it } from "vitest";
import { estimateContextBreakdown } from "./context-breakdown";

describe("estimateContextBreakdown", () => {
	it("splits system prompt, rules, and conversation into disjoint buckets", () => {
		const rulesText = "Always write tests.";
		const systemPrompt = `You are a coding agent.\n\n${rulesText}`;
		const breakdown = estimateContextBreakdown({
			systemPrompt,
			rulesText,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Fix the bug in foo.ts" }],
				},
			],
		});

		expect(breakdown.systemPrompt).toBeGreaterThan(0);
		expect(breakdown.rules).toBeGreaterThan(0);
		expect(breakdown.conversation).toBeGreaterThan(0);
		expect(breakdown.skills).toBe(0);
		expect(breakdown.workflows).toBe(0);
		expect(breakdown.other).toBe(0);
	});

	it("buckets image/file/media parts as other, not conversation", () => {
		const breakdown = estimateContextBreakdown({
			systemPrompt: "sys",
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{
							type: "image",
							image: "data:image/png;base64,AAAA",
							mediaType: "image/png",
						},
					],
				},
			],
		});

		expect(breakdown.conversation).toBeGreaterThan(0);
		expect(breakdown.other).toBeGreaterThan(0);
	});

	it("attributes skills and workflows text to their own buckets, not conversation", () => {
		const skillsText = "## Skill: deploy\nRun the deploy script.".repeat(5);
		const breakdown = estimateContextBreakdown({
			systemPrompt: "sys",
			skillsText,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `/deploy\n\n${skillsText}` }],
				},
			],
		});

		expect(breakdown.skills).toBeGreaterThan(0);
	});

	it("scales every bucket proportionally to match a real reported prompt token count", () => {
		const breakdown = estimateContextBreakdown(
			{
				systemPrompt: "You are a coding agent.",
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "hello".repeat(50) }],
					},
				],
			},
			1000,
		);

		const total =
			breakdown.systemPrompt +
			breakdown.rules +
			breakdown.skills +
			breakdown.workflows +
			breakdown.conversation +
			breakdown.other;
		// Rounding can drift the sum by a token or two per bucket.
		expect(Math.abs(total - 1000)).toBeLessThanOrEqual(5);
	});

	it("returns the raw (unscaled) estimate when no real token count is given", () => {
		const breakdown = estimateContextBreakdown({
			systemPrompt: "x".repeat(300),
			messages: [],
		});
		expect(breakdown.systemPrompt).toBe(100);
	});

	it("handles an empty request without throwing", () => {
		const breakdown = estimateContextBreakdown({ messages: [] });
		expect(breakdown).toEqual({
			systemPrompt: 1,
			rules: 0,
			skills: 0,
			workflows: 0,
			conversation: 1,
			other: 0,
		});
	});
});
