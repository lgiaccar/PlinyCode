import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "../../index"
import { getPlinyBudget } from "../getPlinyBudget"

const mocks = vi.hoisted(() => ({ read: vi.fn(), request: vi.fn(), ready: vi.fn() }))
vi.mock("@/sdk/pliny-budget", () => ({ requestPlinyBudget: mocks.request }))
vi.mock("@/sdk/pliny-api-key-source", () => ({ waitForPlinyApiKeys: mocks.ready }))
vi.mock("@/shared/services/Logger", () => ({ Logger: { warn: vi.fn() } }))
const controller = { getProviderConfigStore: () => ({ read: mocks.read }) } as unknown as Controller
beforeEach(() => {
	vi.resetAllMocks()
	mocks.ready.mockResolvedValue(undefined)
	mocks.read.mockReturnValue({ apiKey: "test-key" })
})
describe("getPlinyBudget", () => {
	it("waits for the active key and allows slow budget aggregation", async () => {
		let loaded = false
		mocks.ready.mockImplementation(async () => {
			loaded = true
		})
		mocks.read.mockImplementation(() => {
			expect(loaded).toBe(true)
			return { apiKey: "active-key" }
		})
		mocks.request.mockResolvedValue({
			status: 200,
			budget: {
				limit: 200,
				used: 120,
				remaining: 80,
				percentage: 60,
				period: "cost_per_month",
				periodEndMs: 0,
				isBlocked: false,
			},
		})
		expect(await getPlinyBudget(controller, {})).toMatchObject({ available: true, remaining: 80 })
		expect(mocks.request).toHaveBeenCalledWith("active-key", { apiKey: "active-key" }, 30_000)
	})
	it("returns an actionable service error for the observed 503 response", async () => {
		mocks.request.mockResolvedValue({ status: 503 })
		expect(await getPlinyBudget(controller, {})).toMatchObject({
			available: false,
			error: "The budget service is unavailable (HTTP 503). Retrying automatically.",
		})
	})
	it("distinguishes rejected credentials from a server outage", async () => {
		mocks.request.mockResolvedValue({ status: 401 })
		expect((await getPlinyBudget(controller, {})).error).toContain("active Pliny API key in Settings")
	})
	it("provides a safe timeout message instead of losing the indicator", async () => {
		mocks.request.mockRejectedValue(new DOMException("private details", "TimeoutError"))
		expect((await getPlinyBudget(controller, {})).error).toBe("The budget request timed out. Retrying automatically.")
	})
})
