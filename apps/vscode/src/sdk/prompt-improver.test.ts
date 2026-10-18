import { describe, expect, it, vi } from "vitest"
import { improvePromptText } from "./prompt-improver"

const DRAFT = "pls fix teh login bug in @/src/auth.ts its not redirecting after logon"

function completer(reply: string | Error) {
	return vi.fn(async () => {
		if (reply instanceof Error) {
			throw reply
		}
		return reply
	})
}

describe("improvePromptText", () => {
	it("asks the commit utility model, with the mode in the instructions and the draft as the message", async () => {
		const complete = completer("Fix the login bug in @/src/auth.ts: it does not redirect after logging in.")
		const result = await improvePromptText(`  ${DRAFT}\n`, "plan", "/ws", complete)

		expect(result).toEqual({ text: "Fix the login bug in @/src/auth.ts: it does not redirect after logging in." })
		const [system, user, signal, workspaceRoot, utility] = complete.mock.calls[0] as unknown as [
			string,
			string,
			AbortSignal,
			string,
			string,
		]
		expect(system).toContain("plan mode")
		expect(system).toContain("@mentions")
		expect(user).toBe(`<draft>\n${DRAFT}\n</draft>`)
		expect(signal).toBeInstanceOf(AbortSignal)
		expect(workspaceRoot).toBe("/ws")
		expect(utility).toBe("commit")
	})

	it("strips a code fence, quotes and a preamble around the rewrite", async () => {
		expect((await improvePromptText(DRAFT, "act", "/ws", completer("```text\nFix the bug.\n```"))).text).toBe("Fix the bug.")
		expect((await improvePromptText(DRAFT, "act", "/ws", completer('"Fix the bug."'))).text).toBe("Fix the bug.")
		expect((await improvePromptText(DRAFT, "act", "/ws", completer("Here is the improved prompt:\nFix the bug."))).text).toBe(
			"Fix the bug.",
		)
	})

	it("takes the rewrite out of echoed draft tags and frees @mentions put in backticks", async () => {
		expect((await improvePromptText(DRAFT, "act", "/ws", completer("<draft>\nFix the bug.\n</draft>"))).text).toBe(
			"Fix the bug.",
		)
		expect(
			(await improvePromptText(DRAFT, "act", "/ws", completer("Add a test for `parseConfig` in `@/src/config.ts`."))).text,
		).toBe("Add a test for `parseConfig` in @/src/config.ts.")
	})

	it("refuses an empty or a very long draft without calling the model", async () => {
		const complete = completer("unused")
		expect((await improvePromptText("   ", "act", "/ws", complete)).error).toMatch(/no prompt/)
		expect((await improvePromptText("x".repeat(8_001), "act", "/ws", complete)).error).toMatch(/too long/)
		expect(complete).not.toHaveBeenCalled()
	})

	it("rejects an empty reply and one that grew far beyond the draft", async () => {
		expect((await improvePromptText(DRAFT, "act", "/ws", completer("  "))).error).toMatch(/no text/)
		expect((await improvePromptText(DRAFT, "act", "/ws", completer("word ".repeat(200)))).error).toMatch(/rewrote more/)
	})

	it("returns the model's failure as an error instead of throwing", async () => {
		const result = await improvePromptText(DRAFT, "act", "/ws", completer(new Error("429 alluser_limit")))
		expect(result.error).toContain("429 alluser_limit")
		expect(result.text).toBeUndefined()
	})

	it("aborts the call when the model takes too long", async () => {
		const complete = vi.fn(
			(_s: string, _u: string, signal: AbortSignal) =>
				new Promise<string>((_resolve, reject) =>
					signal.addEventListener("abort", () => reject(new Error("the utility model did not answer in time"))),
				),
		)
		const result = await improvePromptText(DRAFT, "act", "/ws", complete, 10)
		expect(result.error).toContain("did not answer in time")
	})
})
