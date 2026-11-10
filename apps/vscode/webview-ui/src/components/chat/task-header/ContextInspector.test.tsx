import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { ContextInspector } from "./ContextInspector"

const inspect = vi.hoisted(() => vi.fn())
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { inspectContext: inspect } }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({}) }))
beforeEach(() => {
	inspect.mockReset()
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "")
	}
})
it("selects captured requests and searches their immutable content", async () => {
	inspect.mockResolvedValue({
		value: JSON.stringify({
			omittedRequests: 0,
			requests: [
				{
					id: 1,
					at: 1,
					modelId: "router",
					estimatedTokens: 200,
					notices: [],
					sections: [{ label: "Rules", content: "Old rule", partial: false }],
				},
				{
					id: 2,
					at: 2,
					modelId: "router",
					estimatedTokens: 100,
					notices: ["Preview shortened"],
					sections: [{ label: "Memory", content: "New memory", partial: true }],
				},
			],
		}),
	})
	render(<ContextInspector onClose={vi.fn()} taskId="task" />)
	expect(await screen.findByText("New memory")).toBeTruthy()
	fireEvent.change(screen.getByRole("combobox", { name: "Captured request" }), { target: { value: "1" } })
	expect(screen.getByText("Old rule")).toBeTruthy()
	expect(screen.queryByText("New memory")).toBeNull()
	fireEvent.change(screen.getByRole("searchbox"), { target: { value: "missing" } })
	expect(screen.getByText("No captured sections match this search.")).toBeTruthy()
})
it("explains unavailable snapshots after restart instead of reading today's files", async () => {
	inspect.mockResolvedValue({ value: JSON.stringify({ requests: [], omittedRequests: 0 }) })
	render(<ContextInspector onClose={vi.fn()} taskId="old" />)
	expect(await screen.findByText(/No captured request is available/)).toBeTruthy()
})
