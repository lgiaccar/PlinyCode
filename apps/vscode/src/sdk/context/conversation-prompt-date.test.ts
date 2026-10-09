import { describe, expect, it, vi } from "vitest"
import { ConversationPromptDates, PROMPT_DATE_METADATA_KEY } from "./conversation-prompt-date"

function makeDates(readStoredOverride?: (conversationId: string) => Promise<unknown>) {
	const today = vi.fn(() => "10/9/2026")
	const readStored = vi.fn(readStoredOverride ?? (async (_conversationId: string): Promise<unknown> => undefined))
	const dates = new ConversationPromptDates({ today, readStored })
	return { dates, today, readStored }
}

describe("ConversationPromptDates", () => {
	it("fixes the date when the conversation starts and reuses it on every rebuild", async () => {
		const { dates, today, readStored } = makeDates()

		const first = await dates.prepare(undefined)
		first.bindToSession("task-1")
		expect(first.date).toBe("10/9/2026")

		// Midnight passes; mode switches and resumes must not see it.
		today.mockReturnValue("10/10/2026")
		for (let rebuild = 0; rebuild < 3; rebuild += 1) {
			const again = await dates.prepare("task-1")
			again.bindToSession("task-1")
			expect(again.date).toBe("10/9/2026")
		}
		expect(readStored).not.toHaveBeenCalled()
		expect(dates.sessionMetadata("task-1")).toEqual({ [PROMPT_DATE_METADATA_KEY]: "10/9/2026" })
	})

	it("gives each new conversation its own date", async () => {
		const { dates, today } = makeDates()
		;(await dates.prepare(undefined)).bindToSession("task-1")
		today.mockReturnValue("10/10/2026")
		const second = await dates.prepare(undefined)
		second.bindToSession("task-2")
		expect(second.date).toBe("10/10/2026")
		expect((await dates.prepare("task-1")).date).toBe("10/9/2026")
	})

	it("carries the date to the session an edited message continues under", async () => {
		const { dates, today } = makeDates()
		;(await dates.prepare(undefined)).bindToSession("task-1")
		today.mockReturnValue("10/10/2026")
		const continued = await dates.prepare("task-1")
		continued.bindToSession("task-1-edited")
		expect(dates.sessionMetadata("task-1-edited")).toEqual({ [PROMPT_DATE_METADATA_KEY]: "10/9/2026" })
	})

	it("reads the stored date of a conversation this window has not built yet", async () => {
		const { dates, today, readStored } = makeDates(async () => "10/1/2026")
		const resumed = await dates.prepare("old-task")
		expect(resumed.date).toBe("10/1/2026")
		expect(readStored).toHaveBeenCalledWith("old-task")
		expect(today).not.toHaveBeenCalled()

		// Remembered after the first read.
		await dates.prepare("old-task")
		expect(readStored).toHaveBeenCalledTimes(1)
	})

	it("uses today for a conversation that stored no date, and when the record cannot be read", async () => {
		const { dates } = makeDates(async () => 42)
		expect((await dates.prepare("older-task")).date).toBe("10/9/2026")
		const failing = makeDates(async () => Promise.reject(new Error("gone")))
		expect((await failing.dates.prepare("gone-task")).date).toBe("10/9/2026")
		expect(failing.dates.sessionMetadata("gone-task")).toBeUndefined()
	})
})
