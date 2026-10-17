import { describe, expect, it } from "vitest";
import {
	estimateContextBreakdown,
	SKILLS_LISTING_PREFIX,
} from "./context-breakdown";
import { CHARS_PER_TOKEN } from "./tokens";

function sum(breakdown: Record<string, number>): number {
	return Object.values(breakdown).reduce((total, value) => total + value, 0);
}

const readFileTool = {
	name: "read_file",
	description: "Read the contents of a file at the given path.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path of the file to read" },
		},
		required: ["path"],
	},
};

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
		expect(breakdown.memory).toBe(0);
		expect(breakdown.tools).toBe(0);
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

	it("counts the tool definitions as tools, at their serialized size", () => {
		const tools = Array.from({ length: 20 }, (_, index) => ({
			...readFileTool,
			name: `tool_${index}`,
		}));
		const breakdown = estimateContextBreakdown({
			systemPrompt: "sys",
			tools,
			messages: [],
		});
		const serializedChars = tools.reduce(
			(total, tool) => total + JSON.stringify(tool).length,
			0,
		);
		expect(breakdown.tools).toBe(Math.ceil(serializedChars / CHARS_PER_TOKEN));
		expect(breakdown.systemPrompt).toBe(1);
	});

	it("counts the skills tool's listing as skills and the rest of the tool as tools", () => {
		const listing = `${SKILLS_LISTING_PREFIX}deploy (Ship the build to staging); review-pr (Review a pull request).`;
		const skillsTool = {
			name: "skills",
			description: `Execute a skill within the main conversation.${listing}`,
			inputSchema: { type: "object", properties: {} },
		};
		const breakdown = estimateContextBreakdown({
			tools: [readFileTool, skillsTool],
			messages: [],
		});
		expect(breakdown.skills).toBe(Math.ceil(listing.length / CHARS_PER_TOKEN));
		const toolChars =
			JSON.stringify(readFileTool).length +
			JSON.stringify(skillsTool).length -
			listing.length;
		expect(breakdown.tools).toBe(Math.ceil(toolChars / CHARS_PER_TOKEN));
	});

	it("counts the skills tool's results as skills", () => {
		const body =
			"<command-instructions>Run the deploy script.</command-instructions>";
		const breakdown = estimateContextBreakdown({
			messages: [
				{
					role: "tool",
					content: [
						{
							type: "tool-result",
							toolCallId: "1",
							toolName: "skills",
							output: body.repeat(20),
						},
						{
							type: "tool-result",
							toolCallId: "2",
							toolName: "read_file",
							output: "file contents",
						},
					],
				},
			],
		});
		expect(breakdown.skills).toBeGreaterThan(
			Math.floor((body.length * 20) / CHARS_PER_TOKEN),
		);
		expect(breakdown.conversation).toBeGreaterThan(0);
		expect(breakdown.conversation).toBeLessThan(breakdown.skills);
	});

	it("attributes pasted skill and workflow bodies to their own buckets, not conversation", () => {
		const workflowBody =
			"## Release workflow\n1. Bump the version.\n2. Tag and push.".repeat(5);
		const skillBody =
			"## Deep planning\nRead the code before you plan anything.".repeat(5);
		const typed = "Please do it now";
		const breakdown = estimateContextBreakdown({
			systemPrompt: "sys",
			workflowTexts: [workflowBody],
			skillTexts: [skillBody],
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: `${typed}\n\n${workflowBody}` }],
				},
				{ role: "assistant", content: [{ type: "text", text: "Done." }] },
				{
					role: "user",
					content: [{ type: "text", text: skillBody }],
				},
			],
		});

		expect(breakdown.workflows).toBe(
			Math.ceil(workflowBody.length / CHARS_PER_TOKEN),
		);
		expect(breakdown.skills).toBe(
			Math.ceil(skillBody.length / CHARS_PER_TOKEN),
		);
		// What is left of the user messages: the typed words and the JSON framing.
		expect(breakdown.conversation).toBeLessThan(60);
	});

	it("ignores short or absent pasted bodies", () => {
		const breakdown = estimateContextBreakdown({
			workflowTexts: ["do it"],
			messages: [
				{ role: "user", content: [{ type: "text", text: "do it do it" }] },
			],
		});
		expect(breakdown.workflows).toBe(0);
	});

	it("splits the memory section out of the system prompt only when the prompt contains it", () => {
		const memoryText = "\n\n# Memory\n\n- The build runs on Bun 1.3.\n".repeat(
			4,
		);
		const base = "You are a coding agent.".repeat(10);
		const withMemory = estimateContextBreakdown({
			systemPrompt: `${base}${memoryText}`,
			memoryText,
			messages: [],
		});
		expect(withMemory.memory).toBe(
			Math.ceil(memoryText.length / CHARS_PER_TOKEN),
		);
		expect(withMemory.systemPrompt).toBe(
			Math.ceil(base.length / CHARS_PER_TOKEN),
		);

		const stale = estimateContextBreakdown({
			systemPrompt: base,
			memoryText,
			messages: [],
		});
		expect(stale.memory).toBe(0);
		expect(stale.systemPrompt).toBe(Math.ceil(base.length / CHARS_PER_TOKEN));
	});

	it("estimates at a calibrated characters-per-token ratio", () => {
		const breakdown = estimateContextBreakdown({
			systemPrompt: "x".repeat(400),
			messages: [],
			charsPerToken: 4,
		});
		expect(breakdown.systemPrompt).toBe(100);
	});

	it("scales every bucket proportionally to match a real reported prompt token count", () => {
		const breakdown = estimateContextBreakdown(
			{
				systemPrompt: "You are a coding agent.",
				tools: [readFileTool],
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: "hello".repeat(50) }],
					},
				],
			},
			1000,
		);

		// Rounding can drift the sum by a token or two per bucket.
		expect(Math.abs(sum({ ...breakdown }) - 1000)).toBeLessThanOrEqual(5);
		expect(breakdown.tools).toBeGreaterThan(0);
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
			memory: 0,
			tools: 0,
			skills: 0,
			workflows: 0,
			conversation: 1,
			other: 0,
		});
	});
});
