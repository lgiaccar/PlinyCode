import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { advisorResultMessages } from "../message-translator/advisor-rows"
import { checkAdvisorBudget } from "./advisor-budget"
import { DEFAULT_ADVISOR_SETTINGS } from "./advisor-settings"

type AdvisorBudgetSources = Parameters<typeof checkAdvisorBudget>[1]

const SONNET_5 = DEFAULT_ADVISOR_SETTINGS.model

describe("the advisor's budget rule", () => {
	/** A conversation whose history record says it spent `totalCost` against `spendingLimit`. */
	const check = (totalCost: number | undefined, spendingLimit: number | undefined, defaultBudget = 5) =>
		checkAdvisorBudget("task-1", {
			findHistoryItem: async () => ({ totalCost: totalCost as number, spendingLimit }),
			openTaskMessages: () => undefined,
			defaultBudget: () => defaultBudget,
		})

	it("allows a call while the conversation is under its budget", async () => {
		expect(await check(0, 5)).toBeUndefined()
		expect(await check(4.99, 5)).toBeUndefined()
	})

	it("refuses once the conversation has reached its budget", async () => {
		expect(await check(5, 5)).toBe("This conversation has spent $5.00, reaching its $5.00 budget.")
		expect(await check(0.31, 0.25)).toContain("spent $0.31, reaching its $0.25 budget")
	})

	it("does not check when the budget is off", async () => {
		expect(await check(1000, 0)).toBeUndefined()
		expect(await check(undefined, undefined, 0)).toBeUndefined()
	})

	it("refuses when the conversation's spend cannot be read", async () => {
		expect(await check(undefined, 5)).toContain("could not be checked")
		expect(await check(Number.NaN, 5)).toContain("could not be checked")
	})
})

describe("checkAdvisorBudget", () => {
	let ts = 0
	const row = (say: ClineMessage["say"], text: string): ClineMessage => ({ ts: ++ts, type: "say", say, text })
	/** The usage row the translator adds for an advisor call of this cost. */
	const advisorCall = (totalCost: number) =>
		advisorResultMessages({
			input: { question: "q" },
			output: {
				advice: "a",
				model: SONNET_5,
				usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, totalCost },
			},
			questionTs: ++ts,
			nextTs: () => ++ts,
		})
	const sources = (overrides: Partial<AdvisorBudgetSources>): AdvisorBudgetSources => ({
		findHistoryItem: async () => undefined,
		openTaskMessages: () => undefined,
		defaultBudget: () => 5,
		...overrides,
	})

	it("measures the open task's spend from its chat rows, on a free model too", async () => {
		// A FreeAuto conversation: its model calls cost nothing, its advisor calls do.
		const messages = [
			row("task", "fix it"),
			row("api_req_started", JSON.stringify({ tokensIn: 9000, tokensOut: 300, cost: 0 })),
		]
		const check = () =>
			checkAdvisorBudget(
				"task-1",
				sources({
					openTaskMessages: () => messages,
					findHistoryItem: async () => ({ totalCost: 0, spendingLimit: 0.05 }),
				}),
			)
		expect(await check()).toBeUndefined()

		// Each advisor call's cost counts towards the budget the next one is checked against.
		messages.push(...advisorCall(0.03))
		expect(await check()).toBeUndefined()
		messages.push(...advisorCall(0.03))
		expect(await check()).toBe("This conversation has spent $0.06, reaching its $0.05 budget.")
	})

	it("uses the conversation's own budget, and the default one when it has none", async () => {
		const messages = [row("task", "t"), row("api_req_started", JSON.stringify({ tokensIn: 1, tokensOut: 1, cost: 6 }))]
		const open = { openTaskMessages: () => messages }
		expect(await checkAdvisorBudget("task-1", sources(open))).toContain("reaching its $5.00 budget")
		const raised = sources({ ...open, findHistoryItem: async () => ({ totalCost: 6, spendingLimit: 10 }) })
		expect(await checkAdvisorBudget("task-1", raised)).toBeUndefined()
		expect(await checkAdvisorBudget("task-1", sources({ ...open, defaultBudget: () => 0 }))).toBeUndefined()
	})

	it("checks a background task against the cost in its history record", async () => {
		const background = (totalCost: number) => sources({ findHistoryItem: async () => ({ totalCost, spendingLimit: 2 }) })
		expect(await checkAdvisorBudget("task-2", background(1.5))).toBeUndefined()
		expect(await checkAdvisorBudget("task-2", background(2.5))).toContain("spent $2.50, reaching its $2.00 budget")
	})

	it("refuses when neither the chat rows nor a history record give the spend", async () => {
		expect(await checkAdvisorBudget("unknown", sources({}))).toContain("could not be checked")
	})
})
