import type { AgentMessage } from "@plinycode/shared";
import { describe, expect, it } from "vitest";
import { withHostCompletionGuard } from "./local-runtime-host";

const context = {
	message: {
		id: "a1",
		role: "assistant",
		content: [{ type: "text", text: "Let me check:" }],
		createdAt: 0,
	} satisfies AgentMessage,
	iteration: 3,
};

describe("withHostCompletionGuard", () => {
	it("keeps core's policy untouched when the host has no guard", () => {
		const policy = { requireCompletionTool: true };
		expect(withHostCompletionGuard(policy, undefined)).toBe(policy);
		expect(withHostCompletionGuard(undefined, undefined)).toBeUndefined();
	});

	it("installs the host guard on its own, passing it the reply", () => {
		const seen: unknown[] = [];
		const merged = withHostCompletionGuard(undefined, (ctx) => {
			seen.push(ctx);
			return "keep going";
		});
		expect(merged?.completionGuard?.(context)).toBe("keep going");
		expect(seen).toEqual([context]);
	});

	it("asks core's guard first and keeps its other settings", () => {
		const merged = withHostCompletionGuard(
			{ requireCompletionTool: true, completionGuard: () => "team first" },
			() => "host",
		);
		expect(merged?.requireCompletionTool).toBe(true);
		expect(merged?.completionGuard?.(context)).toBe("team first");
	});

	it("falls back to the host guard when core's has nothing to say", () => {
		const merged = withHostCompletionGuard(
			{ completionGuard: () => undefined },
			() => "host",
		);
		expect(merged?.completionGuard?.(context)).toBe("host");
	});
});
