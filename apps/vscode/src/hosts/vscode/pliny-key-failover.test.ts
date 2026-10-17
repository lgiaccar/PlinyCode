import { describe, expect, it, vi } from "vitest"

vi.mock("vscode", () => ({ window: {}, commands: {} }))

import type { PlinyApiKeyEntry } from "./pliny-api-keys"
import { PlinyKeyFailover, type PlinyKeyFailoverDeps } from "./pliny-key-failover"

const entry = (id: string): PlinyApiKeyEntry => ({ id, name: id.toUpperCase(), last4: "0000", createdAt: 0 })

function setup(options: { ids?: string[]; budget?: Awaited<ReturnType<PlinyKeyFailoverDeps["checkBudget"]>> } = {}) {
	const ids = options.ids ?? ["a", "b"]
	let active = ids[0]
	const asked: Array<{ message: string; items: string[] }> = []
	let answer: (items: string[]) => string | undefined = (items) => items[0]
	let clock = 0
	const deps: PlinyKeyFailoverDeps = {
		keys: {
			activeId: () => active,
			activeKey: () => (active ? `test-key-${active}` : undefined),
			list: () => ids.map(entry),
			nextAfter: (id, exclude = new Set()) => {
				const start = ids.indexOf(id)
				for (let step = 1; step <= ids.length; step++) {
					const candidate = ids[(start + step) % ids.length]
					if (candidate !== id && !exclude.has(candidate)) return entry(candidate)
				}
				return undefined
			},
			setActive: async (id) => {
				active = id
			},
		},
		checkBudget: vi.fn(async () => options.budget ?? { status: 200 }),
		ask: async (message, items) => {
			asked.push({ message, items })
			return answer(items)
		},
		openSettings: vi.fn(),
		now: () => clock,
	}
	return {
		failover: new PlinyKeyFailover(deps),
		deps,
		asked,
		active: () => active,
		answerWith: (pick: (items: string[]) => string | undefined) => {
			answer = pick
		},
		advance: (ms: number) => {
			clock += ms
		},
	}
}

const blocked = { status: 200, budget: { isBlocked: true, remaining: 0, mode: "enforce" } as never }

describe("PlinyKeyFailover", () => {
	it("offers the next key when the gateway rejects the active one, and switches on the button", async () => {
		const t = setup()
		await t.failover.handle({ errorClass: "auth", message: "401" })

		expect(t.asked).toEqual([
			{
				message: 'The Pliny gateway rejected the API key "A". Switch to "B" and click Retry?',
				items: ['Switch to "B"', "Manage Keys"],
			},
		])
		expect(t.active()).toBe("b")
		expect(t.deps.checkBudget).not.toHaveBeenCalled()
	})

	it("asks the budget endpoint about other failures, and offers a switch when the budget is used up", async () => {
		const t = setup({ budget: blocked })
		await t.failover.handle({ errorClass: "unknown", message: "429" })

		expect(t.asked[0]?.message).toBe('The Pliny API key "A" has used up its budget. Switch to "B" and click Retry?')
	})

	it("says nothing about a failure while the budget has money left, and checks at most once a minute", async () => {
		const t = setup({ budget: { status: 200, budget: { isBlocked: false, remaining: 12, mode: "enforce" } as never } })
		await t.failover.handle({ message: "rate limited" })
		await t.failover.handle({ message: "rate limited" })
		expect(t.deps.checkBudget).toHaveBeenCalledTimes(1)
		t.advance(60_000)
		await t.failover.handle({ message: "rate limited" })
		expect(t.deps.checkBudget).toHaveBeenCalledTimes(2)
		expect(t.asked).toEqual([])
	})

	it("offers once per key and reason, and only Settings once every key failed", async () => {
		const t = setup()
		t.answerWith(() => undefined)
		await t.failover.handle({ errorClass: "auth", message: "401" })
		await t.failover.handle({ errorClass: "auth", message: "401" })
		expect(t.asked).toHaveLength(1)

		await t.deps.keys.setActive("b")
		t.answerWith((items) => items.at(-1))
		await t.failover.handle({ errorClass: "auth", message: "401" })
		expect(t.asked[1]).toEqual({
			message: 'The Pliny gateway rejected the API key "B". Add or choose another key in Settings.',
			items: ["Manage Keys"],
		})
		expect(t.deps.openSettings).toHaveBeenCalled()
	})

	it("gives a key the user picks again a fresh chance", async () => {
		const t = setup()
		t.answerWith(() => undefined)
		await t.failover.handle({ errorClass: "auth", message: "401" })
		t.failover.activeChanged("a")
		await t.failover.handle({ errorClass: "auth", message: "401" })
		expect(t.asked).toHaveLength(2)
	})

	it("does nothing without a stored key (PLINY_API_KEY or providers.json in use)", async () => {
		const t = setup({ ids: [] })
		await t.failover.handle({ errorClass: "auth", message: "401" })
		expect(t.asked).toEqual([])
	})
})
