import { describe, expect, it, vi } from "vitest";
import {
	cleanNextPrompt,
	NextPromptSuggestions,
	nextPromptContext,
} from "./next-prompt";

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
	it("rejects absent, multiline and oversized suggestions", () => {
		for (const text of [
			"NONE",
			"None.",
			"",
			"a\nb",
			"a".repeat(201),
			"`run tests`",
		])
			expect(cleanNextPrompt(text)).toBe("");
		expect(cleanNextPrompt('"Add tests for the edge cases."')).toBe(
			"Add tests for the edge cases.",
		);
	});
	it("deduplicates a completion, separates chats, and passes no tool execution", async () => {
		const complete = vi.fn(async () => "Add a regression test.");
		const service = new NextPromptSuggestions();
		const turns = [{ role: "user" as const, text: "Fix parsing" }];
		expect(
			await Promise.all([
				service.suggest("a:1", turns, complete),
				service.suggest("a:1", turns, complete),
			]),
		).toEqual(["Add a regression test.", "Add a regression test."]);
		expect(complete).toHaveBeenCalledTimes(1);
		await service.suggest("b:1", turns, complete);
		expect(complete).toHaveBeenCalledTimes(2);
		expect(complete.mock.calls[0]).toHaveLength(3);
	});
	it("times out even a provider that ignores abort and suppresses failures", async () => {
		const service = new NextPromptSuggestions();
		let signal: AbortSignal | undefined;
		expect(
			await service.suggest(
				"timeout",
				[],
				async (_s, _u, s) => {
					signal = s;
					return new Promise(() => {});
				},
				5,
			),
		).toBe("");
		expect(signal?.aborted).toBe(true);
		expect(
			await service.suggest("error", [], async () => {
				throw new Error("secret");
			}),
		).toBe("");
	});
	it("cancels pending requests on shutdown", async () => {
		const service = new NextPromptSuggestions();
		const result = service.suggest("a", [], async () => new Promise(() => {}));
		service.close();
		expect(await result).toBe("");
	});
});
