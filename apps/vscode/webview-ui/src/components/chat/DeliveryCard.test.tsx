import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { DeliveryCard } from "./DeliveryCard"

const getEvidence = vi.hoisted(() => vi.fn())
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ currentTaskItem: { id: "task" } }) }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { getDeliveryEvidence: getEvidence } }))
beforeEach(() => {
	getEvidence.mockReset()
})

it("shows unknown publication, inspectable results and current remote status", async () => {
	getEvidence.mockResolvedValue({
		value: JSON.stringify({
			evidence: [
				{ id: "1", category: "checks", tool: "run_commands", input: "bun test", output: "3 failed", failed: true },
			],
			omitted: 0,
			remote: {
				branch: "feature",
				checkedAt: 1,
				pr: { id: 42, state: "merged", url: "https://example.com/pr/42", head: "12345678" },
				checks: [],
			},
		}),
	})
	const onContinue = vi.fn()
	render(<DeliveryCard onContinue={onContinue} />)
	expect(await screen.findByText("PR #42 · merged")).toBeTruthy()
	expect(screen.getByText(/Publication/).parentElement?.textContent).toContain("Not confirmed")
	expect(screen.getByText(/CI · No checks reported/)).toBeTruthy()
	expect(screen.getByText(/3 failed/)).toBeTruthy()
	fireEvent.click(screen.getByRole("button", { name: "Verify delivery with agent" }))
	expect(onContinue).toHaveBeenCalledWith(expect.stringContaining("Do not publish or merge without existing authorization"))
	fireEvent.click(screen.getByRole("button", { name: "Refresh evidence" }))
	await waitFor(() => expect(getEvidence).toHaveBeenCalledTimes(2))
})

it("reports loading errors without inventing a successful status", async () => {
	getEvidence.mockRejectedValue(new Error("offline"))
	render(<DeliveryCard />)
	expect(await screen.findByRole("alert")).toHaveTextContent("could not be loaded")
})
