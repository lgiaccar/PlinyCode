import { describe, expect, test } from "bun:test";
import type { ApiHandler, createHandlerAsync } from "@plinycode/llms";
import {
	cleanImprovedPrompt,
	IMPROVE_MODEL,
	PromptImprover,
} from "../src/prompt-improver";

function fixture(reply: string) {
	const requests: unknown[][] = [];
	const configs: unknown[] = [];
	const create: typeof createHandlerAsync = async (config) => {
		configs.push(config);
		return {
			createMessage: async function* (...args: unknown[]) {
				requests.push(args);
				yield { type: "text", text: reply };
			},
		} as ApiHandler;
	};
	return { improver: new PromptImprover(create), configs, requests };
}
describe("desktop prompt improvement", () => {
	test("uses a fixed free model with only the draft and no tools", async () => {
		const f = fixture("Please fix the tests.");
		expect(await f.improver.improve("plese fix tests", "secret")).toEqual({
			text: "Please fix the tests.",
		});
		expect(f.configs[0]).toMatchObject({
			modelId: IMPROVE_MODEL,
			providerId: "pliny",
			apiKey: "secret",
		});
		expect(f.requests[0]).toHaveLength(2);
		expect(f.requests[0][1]).toEqual([
			{ role: "user", content: "<draft>\nplese fix tests\n</draft>" },
		]);
	});
	test("validates input without a model call", async () => {
		const f = fixture("unused");
		for (const [draft, key] of [
			[" ", "key"],
			["a".repeat(8001), "key"],
			["hello", ""],
		])
			expect((await f.improver.improve(draft, key)).error).toBeDefined();
		expect(f.configs).toHaveLength(0);
	});
	test("rejects empty or inflated responses", async () => {
		for (const reply of ["", "a".repeat(201), "a".repeat(24001)])
			expect(
				(await fixture(reply).improver.improve("fix tests", "key")).error,
			).toBeDefined();
	});
	test("cleans wrappers while preserving Markdown and code blocks", () => {
		expect(cleanImprovedPrompt("```markdown\nFix `@/src/main.ts`.\n```")).toBe(
			"Fix @/src/main.ts.",
		);
		const markdown = "Check this:\n```ts\nconst x = 1;\n```\nThen test it.";
		expect(cleanImprovedPrompt(markdown)).toBe(markdown);
	});
	test("bounds stalled initialization, blocks concurrent calls and permits retry", async () => {
		const improver = new PromptImprover(() => new Promise(() => {}), 15);
		const first = improver.improve("fix tests", "key");
		expect((await improver.improve("fix tests", "key")).error).toContain(
			"already running",
		);
		expect((await first).error).toContain("timed out");
		expect((await improver.improve("fix tests", "key")).error).toContain(
			"timed out",
		);
	});
	test("shutdown cancels immediately and failures do not expose secrets", async () => {
		const improver = new PromptImprover(() => new Promise(() => {}));
		const pending = improver.improve("draft", "key");
		improver.close();
		expect((await pending).error).toContain("cancelled");
		const failed = new PromptImprover(async () => {
			throw new Error("SECRET_ENDPOINT and PRIVATE_DRAFT");
		});
		expect((await failed.improve("draft", "key")).error).not.toContain(
			"SECRET_ENDPOINT",
		);
	});
});
