import { expect, test } from "bun:test";
import type { ApiHandler } from "@plinycode/llms";
import type { Task } from "../src/contracts";
import { DesktopNextPrompt } from "../src/next-prompt";

test("only completed matching turns can request a tool-free suggestion", async () => {
	const requests: unknown[][] = [];
	const service = new DesktopNextPrompt(
		async () =>
			({
				createMessage: async function* (...args: unknown[]) {
					requests.push(args);
					yield { type: "text", text: "Add regression tests." };
				},
			}) as ApiHandler,
	);
	const task = {
		id: "chat",
		status: "completed",
		messages: [
			{ id: "user", role: "user", text: "Fix parsing" },
			{ id: "answer", role: "assistant", text: "Fixed parsing. Tests remain." },
			{ id: "tool", role: "activity", text: "tool output excluded" },
		],
	} as Task;
	for (const status of [
		"running",
		"failed",
		"cancelled",
		"needs_input",
	] as const)
		expect(await service.suggest({ ...task, status }, "answer", "key")).toBe(
			"",
		);
	expect(await service.suggest(task, "old", "key")).toBe("");
	expect(requests).toHaveLength(0);
	expect(await service.suggest(task, "answer", "key")).toBe(
		"Add regression tests.",
	);
	expect(requests[0]).toHaveLength(2);
	expect(JSON.stringify(requests)).not.toContain("tool output excluded");
	expect(JSON.stringify(requests)).toContain("Fix parsing");
});
