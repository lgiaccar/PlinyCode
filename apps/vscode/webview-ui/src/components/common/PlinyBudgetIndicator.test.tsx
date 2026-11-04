import { PlinyBudgetResponse } from "@shared/proto/cline/models"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invalidatePlinyBudget } from "@/hooks/usePlinyBudget"
import PlinyBudgetIndicator from "./PlinyBudgetIndicator"

const mocks = vi.hoisted(() => ({ getPlinyBudget: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: mocks }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ apiConfiguration: { actModeApiProvider: "pliny" }, mode: "act" }),
}))
const available = (remaining = 80) =>
	PlinyBudgetResponse.create({
		available: true,
		limit: 200,
		used: 200 - remaining,
		remaining,
		percentage: 60,
		period: "cost_per_month",
	})
const unavailable = () =>
	PlinyBudgetResponse.create({ error: "The budget service is unavailable (HTTP 503). Retrying automatically." })
const settle = async () => {
	await act(async () => {
		await Promise.resolve()
	})
}

beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-11-04T12:00:00Z"))
	vi.resetAllMocks()
	invalidatePlinyBudget()
})
afterEach(() => {
	cleanup()
	invalidatePlinyBudget()
	vi.useRealTimers()
})

describe("Pliny budget visibility and recovery", () => {
	it("keeps a loading/unavailable row visible and restores the balance on manual retry", async () => {
		mocks.getPlinyBudget.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(available())
		render(<PlinyBudgetIndicator />)
		expect(screen.getByRole("status")).toHaveTextContent("Pliny budget: loading")
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("Pliny budget: unavailable")
		expect(screen.getByText(/HTTP 503/)).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Retry Pliny budget" }))
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("Pliny budget: $80.00 left of $200.00 this month")
		expect(screen.queryByText(/HTTP 503/)).not.toBeInTheDocument()
	})
	it("automatically recovers without any new conversation spending", async () => {
		mocks.getPlinyBudget.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(available(75))
		render(<PlinyBudgetIndicator refreshKey={0} />)
		await settle()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000)
		})
		expect(mocks.getPlinyBudget).toHaveBeenCalledTimes(2)
		expect(screen.getByRole("status")).toHaveTextContent("$75.00 left")
	})
	it("preserves and labels the last known balance after a gateway failure", async () => {
		mocks.getPlinyBudget.mockResolvedValueOnce(available()).mockResolvedValueOnce(unavailable())
		render(<PlinyBudgetIndicator />)
		await settle()
		fireEvent.click(screen.getByRole("button", { name: "Refresh Pliny budget" }))
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("Last known — Pliny budget: $80.00")
		expect(screen.getByText(/Last updated/)).toHaveTextContent("HTTP 503")
	})
	it("reports RPC failures instead of hiding or exposing raw error details", async () => {
		mocks.getPlinyBudget.mockRejectedValue(new Error("internal transport details"))
		render(<PlinyBudgetIndicator />)
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("unavailable")
		expect(screen.getByRole("button", { name: "Retry Pliny budget" })).toBeEnabled()
		expect(screen.queryByText(/internal transport/)).not.toBeInTheDocument()
	})
	it("shares requests and updates between mounted indicators", async () => {
		mocks.getPlinyBudget.mockResolvedValueOnce(available()).mockResolvedValueOnce(available(70))
		render(
			<>
				<PlinyBudgetIndicator />
				<PlinyBudgetIndicator />
			</>,
		)
		await settle()
		expect(mocks.getPlinyBudget).toHaveBeenCalledTimes(1)
		fireEvent.click(screen.getAllByRole("button", { name: "Refresh Pliny budget" })[0])
		await settle()
		expect(mocks.getPlinyBudget).toHaveBeenCalledTimes(2)
		for (const row of screen.getAllByRole("status")) expect(row).toHaveTextContent("$70.00 left")
	})
	it("discards a previous key's pending response and clears its cached balance", async () => {
		let resolveOld!: (value: PlinyBudgetResponse) => void
		mocks.getPlinyBudget
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveOld = resolve
					}),
			)
			.mockResolvedValueOnce(available(25))
		render(<PlinyBudgetIndicator />)
		act(() => invalidatePlinyBudget())
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("$25.00 left")
		await act(async () => resolveOld(available(180)))
		expect(screen.getByRole("status")).toHaveTextContent("$25.00 left")
		mocks.getPlinyBudget.mockResolvedValueOnce(unavailable())
		act(() => invalidatePlinyBudget())
		await settle()
		expect(screen.getByRole("status")).toHaveTextContent("unavailable")
		expect(screen.queryByText(/\$25/)).not.toBeInTheDocument()
	})
	it("stops polling when no indicator is mounted", async () => {
		mocks.getPlinyBudget.mockResolvedValue(available())
		const view = render(<PlinyBudgetIndicator />)
		await settle()
		view.unmount()
		await act(async () => {
			await vi.advanceTimersByTimeAsync(180_000)
		})
		expect(mocks.getPlinyBudget).toHaveBeenCalledTimes(1)
	})
})
