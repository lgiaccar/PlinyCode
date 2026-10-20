import { describe, expect, it, vi } from "vitest"
import { suggestConversationTitle } from "./conversation-title"

const titleFor = (reply: string) =>
	suggestConversationTitle(
		"fix it",
		"/ws",
		vi.fn(async () => reply),
	)

describe("suggestConversationTitle", () => {
	it("keeps the first line, without quotes, markdown, a label or a final period", async () => {
		expect(await titleFor('"Fix login redirect loop."')).toBe("Fix login redirect loop")
		expect(await titleFor("Title: **Explain compaction**\nbecause it is long")).toBe("Explain compaction")
		expect(await titleFor("# Add a retry")).toBe("Add a retry")
	})

	it("cuts a very long title", async () => {
		expect((await titleFor("word ".repeat(40)))?.length).toBeLessThanOrEqual(80)
	})

	it("asks the commit utility model with the prompt as the message", async () => {
		const complete = vi.fn(async () => "Fix login redirect")
		expect(await suggestConversationTitle("  fix the login redirect\n", "/ws", complete)).toBe("Fix login redirect")
		const [, user, , workspaceRoot, utility] = complete.mock.calls[0] as unknown as [
			string,
			string,
			AbortSignal,
			string,
			string,
		]
		expect(user).toBe("<prompt>\nfix the login redirect\n</prompt>")
		expect(workspaceRoot).toBe("/ws")
		expect(utility).toBe("commit")
	})

	it("returns undefined for a blank prompt, an empty reply or a failure", async () => {
		expect(await suggestConversationTitle("  ", "/ws", vi.fn())).toBeUndefined()
		expect(await titleFor("  ")).toBeUndefined()
		expect(
			await suggestConversationTitle(
				"hi",
				"/ws",
				vi.fn(async () => {
					throw new Error("429")
				}),
			),
		).toBeUndefined()
	})
})
