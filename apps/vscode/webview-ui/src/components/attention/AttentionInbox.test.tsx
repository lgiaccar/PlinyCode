import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { AttentionInbox } from "./AttentionInbox"

const rpc = vi.hoisted(() => ({ manageAttention: vi.fn(), showTaskWithId: vi.fn(), navigateToChat: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: rpc }))
vi.mock("@/components/ciBoard/useCiBoard", () => ({ useCiBoard: () => ({ targets: [], unavailable: "" }) }))
vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ navigateToChat: rpc.navigateToChat, navigateToCiBoard: vi.fn() }),
}))

beforeEach(() => {
	vi.clearAllMocks()
	HTMLDialogElement.prototype.showModal = function () {
		this.setAttribute("open", "")
	}
	rpc.manageAttention.mockResolvedValue({
		value: JSON.stringify({
			workspace: "/repo",
			omitted: 0,
			tasks: [
				{ id: "a", title: "Approve test run", updatedAt: 1, status: "approval" },
				{ id: "b", title: "New header", updatedAt: 2, status: "review" },
				{ id: "c", title: "Still working", updatedAt: 3, status: "running" },
			],
		}),
	})
	rpc.showTaskWithId.mockResolvedValue({})
})

it("opens the real approval rather than approving from a stale inbox", async () => {
	const close = vi.fn()
	render(<AttentionInbox onClose={close} />)
	fireEvent.click(await screen.findByRole("button", { name: "Review approval" }))
	await waitFor(() => expect(rpc.showTaskWithId).toHaveBeenCalledWith({ value: "a" }))
	expect(close).toHaveBeenCalled()
})

it("filters running tasks, scopes queries and versions review acknowledgements", async () => {
	render(<AttentionInbox onClose={vi.fn()} />)
	fireEvent.click(await screen.findByRole("button", { name: "Mark reviewed" }))
	await waitFor(() =>
		expect(rpc.manageAttention).toHaveBeenCalledWith({
			value: JSON.stringify({ reviewId: "b", updatedAt: 2, allWorkspaces: false }),
		}),
	)
	fireEvent.click(screen.getByRole("button", { name: "Running (1)" }))
	expect(screen.getByText("Still working")).toBeTruthy()
	expect(screen.queryByText("Approve test run")).toBeNull()
	fireEvent.click(screen.getByRole("checkbox", { name: "All workspaces" }))
	await waitFor(() => expect(rpc.manageAttention).toHaveBeenCalledWith({ value: JSON.stringify({ allWorkspaces: true }) }))
})
