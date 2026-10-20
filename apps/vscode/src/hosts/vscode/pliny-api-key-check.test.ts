import { describe, expect, it, vi } from "vitest"

vi.mock("@/sdk/model-catalog/effective-config", () => ({
	buildEffectiveProviderConfig: () => ({ baseUrl: "https://gateway.example/api/llm/", headers: { "X-Team": "t" } }),
}))
vi.mock("@/sdk/router/router-rules-store", () => ({
	loadRouterRules: async () => ({ utility: { commit: "snps-provider/free-model" } }),
}))
vi.mock("@/sdk/pliny-budget", () => ({ requestPlinyBudget: vi.fn() }))

import { type PlinyKeyTestDeps, plinyKeyNameProblem, plinyNewKeyProblem, testPlinyApiKey } from "./pliny-api-key-check"
import type { PlinyApiKeyEntry } from "./pliny-api-keys"

const entry = (id: string, name: string): PlinyApiKeyEntry => ({ id, name, last4: "0000", createdAt: 0 })

function store(entries: PlinyApiKeyEntry[], values: Record<string, string> = {}) {
	return {
		list: () => entries,
		findByValue: async (key: string) => entries.find((e) => values[e.id] === key),
	}
}

function deps(respond: () => Promise<Response>): PlinyKeyTestDeps & { calls: Array<[string, RequestInit]> } {
	const calls: Array<[string, RequestInit]> = []
	let clock = 1000
	return {
		calls,
		fetch: (async (url: string, init: RequestInit) => {
			calls.push([url, init])
			clock += 42
			return respond()
		}) as unknown as typeof fetch,
		modelId: async () => "snps-provider/free-model",
		now: () => clock,
	}
}

describe("plinyKeyNameProblem", () => {
	it("requires a nickname that no other key has, ignoring case and the key being renamed", () => {
		const keys = store([entry("a", "Personal"), entry("b", "Team")])
		expect(plinyKeyNameProblem(keys, "  ")).toMatch(/Enter a nickname/)
		expect(plinyKeyNameProblem(keys, " team ")).toMatch(/already named "team"/)
		expect(plinyKeyNameProblem(keys, "Team", "b")).toBeUndefined()
		expect(plinyKeyNameProblem(keys, "Other")).toBeUndefined()
	})
})

describe("plinyNewKeyProblem", () => {
	it("refuses a key already stored, and asks the gateway about a new one", async () => {
		const keys = store([entry("a", "Personal")], { a: "sk-1" })
		const gateway = vi.fn(async () => undefined)
		expect(await plinyNewKeyProblem(keys, "Other", " sk-1 ", gateway)).toMatch(/already stored as "Personal"/)
		expect(await plinyNewKeyProblem(keys, "Other", "  ", gateway)).toMatch(/Paste the key/)
		expect(gateway).not.toHaveBeenCalled()

		expect(await plinyNewKeyProblem(keys, "Other", "sk-2", gateway)).toBeUndefined()
		expect(gateway).toHaveBeenCalledWith("sk-2")
		expect(await plinyNewKeyProblem(keys, "Other", "sk-3", async () => "rejected")).toBe("rejected")
	})
})

describe("testPlinyApiKey", () => {
	it("sends a one-token completion to a free model and reports green with the latency", async () => {
		const d = deps(async () => new Response("{}", { status: 200 }))
		const result = await testPlinyApiKey(" sk-1 ", d)

		expect(result).toMatchObject({ ok: true, status: 200, latencyMs: 42 })
		expect(result.message).toMatch(/answered in 42 ms/)
		const [url, init] = d.calls[0]
		expect(url).toBe("https://gateway.example/api/llm/chat/completions")
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-1")
		expect((init.headers as Record<string, string>)["X-Team"]).toBe("t")
		expect(JSON.parse(init.body as string)).toMatchObject({ model: "snps-provider/free-model", max_tokens: 1 })
	})

	it("reports a rejected key red", async () => {
		const result = await testPlinyApiKey(
			"bad",
			deps(async () => new Response("nope", { status: 401 })),
		)
		expect(result).toMatchObject({ ok: false, status: 401 })
		expect(result.message).toMatch(/rejected this key \(HTTP 401\)/)
	})

	it("reports another failure red with the gateway's message", async () => {
		const body = JSON.stringify({ error: { message: "model is overloaded" } })
		const result = await testPlinyApiKey(
			"sk",
			deps(async () => new Response(body, { status: 503 })),
		)
		expect(result).toMatchObject({
			ok: false,
			status: 503,
			message: "The Pliny inference server answered HTTP 503: model is overloaded",
		})
	})

	it("reports an unreachable server red with status 0", async () => {
		const result = await testPlinyApiKey(
			"sk",
			deps(async () => {
				throw new Error("getaddrinfo ENOTFOUND")
			}),
		)
		expect(result).toMatchObject({ ok: false, status: 0 })
		expect(result.message).toMatch(/Could not reach .*ENOTFOUND/)
	})
})
