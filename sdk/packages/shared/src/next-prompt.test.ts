import { describe, expect, it, vi } from "vitest";
import {
	cleanNextPrompts,
	NextPromptSuggestions,
	nextPromptContext,
} from "./next-prompt";

const ready = { status: "ready", prompts: ["Add tests."] };
const error = { status: "error", prompts: [] };
describe("next prompt suggestions", () => {
	it("bounds conversation context and preserves roles", () => {
		const turns = Array.from({ length: 10 }, (_, i) => ({
			role: "user" as const,
			text: `${i}`.repeat(3000),
		}));
		const context = JSON.parse(nextPromptContext(turns));
		expect(context).toHaveLength(6);
		expect(context[0]).toEqual({ role: "user", text: "4".repeat(2000) });
	});
	it("validates bounded choices and distinguishes empty from invalid", () => {
		for (const value of [
			"NONE",
			"",
			'"Add tests."',
			"[1]",
			'[""]',
			JSON.stringify(["a".repeat(201)]),
			JSON.stringify(["a\nb"]),
			JSON.stringify(["`test`"]),
			'["a","b","c","d"]',
		])
			expect(cleanNextPrompts(value)).toBeUndefined();
		expect(cleanNextPrompts("[]")).toEqual([]);
		expect(
			cleanNextPrompts('[" Add tests. ","add tests.","Review changes."]'),
		).toEqual(["Add tests.", "Review changes."]);
		expect(cleanNextPrompts('```json\n["Add tests."]\n```')).toEqual([
			"Add tests.",
		]);
	});
	it("deduplicates requests per completion and separates chats", async () => {
		const complete = vi.fn(async () => JSON.stringify(ready.prompts));
		const service = new NextPromptSuggestions();
		expect(
			await Promise.all([
				service.suggest("a", [], complete),
				service.suggest("a", [], complete),
			]),
		).toEqual([ready, ready]);
		expect(complete).toHaveBeenCalledTimes(1);
		await service.suggest("b", [], complete);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[0]).toHaveLength(3);
	});
	it("forces fresh alternatives and supplies previous choices", async () => {
		const complete = vi.fn(async () => JSON.stringify(ready.prompts));
		const service = new NextPromptSuggestions();
		await service.suggest("a", [], complete);
		await service.suggest("a", [], complete, { force: true });
		expect(complete).toHaveBeenCalledTimes(2);
		expect(
			JSON.parse((complete.mock.calls[1] as unknown as string[])[1])
				.previousSuggestions,
		).toEqual(ready.prompts);
	});
	it("caches deliberate empty results but allows force", async () => {
		const complete = vi.fn(async () => "[]");
		const service = new NextPromptSuggestions();
		expect(await service.suggest("a", [], complete)).toEqual({
			status: "empty",
			prompts: [],
		});
		await service.suggest("a", [], complete);
		expect(complete).toHaveBeenCalledTimes(1);
		await service.suggest("a", [], complete, { force: true });
		expect(complete).toHaveBeenCalledTimes(2);
	});
	it("does not cache malformed results or provider failures", async () => {
		const service = new NextPromptSuggestions();
		expect(await service.suggest("a", [], async () => "invalid")).toEqual(
			error,
		);
		expect(
			await service.suggest("a", [], async () => {
				throw Error("secret");
			}),
		).toEqual(error);
		expect(
			await service.suggest("a", [], async () => JSON.stringify(ready.prompts)),
		).toEqual(ready);
	});
	it("times out providers that ignore abort", async () => {
		const service = new NextPromptSuggestions();
		let signal: AbortSignal | undefined;
		expect(
			await service.suggest(
				"a",
				[],
				async (_s, _u, s) => {
					signal = s;
					return new Promise(() => {});
				},
				{ timeoutMs: 5 },
			),
		).toEqual(error);
		expect(signal?.aborted).toBe(true);
	});
	it("a replaced request cannot evict or overwrite the fresh result", async () => {
		const service = new NextPromptSuggestions();
		let resolve!: (text: string) => void;
		const old = service.suggest(
			"a",
			[],
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const fresh = service.suggest(
			"a",
			[],
			async () => JSON.stringify(ready.prompts),
			{ force: true },
		);
		expect(await old).toEqual(error);
		expect(await fresh).toEqual(ready);
		resolve('["Old result"]');
		expect(await service.suggest("a", [], async () => "[]")).toEqual(ready);
	});
	it("cancels pending requests on shutdown", async () => {
		const service = new NextPromptSuggestions();
		const pending = service.suggest("a", [], async () => new Promise(() => {}));
		service.close();
		expect(await pending).toEqual(error);
	});
});
