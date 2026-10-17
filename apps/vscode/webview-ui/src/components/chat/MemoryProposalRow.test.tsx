import type { ClineMessage } from "@shared/ExtensionMessage"
import type { MemoryProposal } from "@shared/memory-proposal"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import MemoryProposalRow from "./MemoryProposalRow"

const resolveMemoryProposal = vi.fn((_request: unknown) => Promise.resolve({}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		resolveMemoryProposal: (request: unknown) => resolveMemoryProposal(request),
	},
}))

const PROPOSAL: MemoryProposal = {
	id: "p1",
	conversationId: "c1",
	status: "pending",
	repo: "github.com/org/repo",
	items: [
		{ id: "0", scope: "repo", text: "git log needs --no-pager here", importance: "high" },
		{ id: "1", scope: "user", text: "Prefers short answers", importance: "normal" },
	],
}

function row(proposal: MemoryProposal): ClineMessage {
	return { ts: 1, type: "say", say: "memory_proposal", text: JSON.stringify(proposal), partial: false }
}

describe("MemoryProposalRow", () => {
	beforeEach(() => resolveMemoryProposal.mockClear())

	it("lists each proposal checked, with where it would be saved", () => {
		render(<MemoryProposalRow message={row(PROPOSAL)} />)
		const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[]
		expect(boxes.map((box) => box.checked)).toEqual([true, true])
		expect(screen.getByText(/repository memory · important/)).toBeTruthy()
		expect(screen.getByText(/your memory/)).toBeTruthy()
		expect(screen.getByRole("button", { name: "Save all" })).toBeTruthy()
	})

	it("saves only the checked items", () => {
		render(<MemoryProposalRow message={row(PROPOSAL)} />)
		fireEvent.click(screen.getAllByRole("checkbox")[1])
		fireEvent.click(screen.getByRole("button", { name: "Save 1" }))
		expect(resolveMemoryProposal).toHaveBeenCalledWith(
			expect.objectContaining({ proposalId: "p1", save: true, itemIds: ["0"] }),
		)
	})

	it("dismisses", () => {
		render(<MemoryProposalRow message={row(PROPOSAL)} />)
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }))
		expect(resolveMemoryProposal).toHaveBeenCalledWith(expect.objectContaining({ proposalId: "p1", save: false }))
	})

	it("lists stale entries for removal apart, and applies the choice", () => {
		const proposal: MemoryProposal = {
			...PROPOSAL,
			items: [
				PROPOSAL.items[0],
				{ id: "remove-0", scope: "repo", text: "The old build script", importance: "normal", action: "remove" },
			],
		}
		render(<MemoryProposalRow message={row(proposal)} />)
		expect(screen.getByTestId("memory-proposal-removals").textContent).toMatch(/Not used for 90 days/)
		fireEvent.click(screen.getAllByRole("checkbox")[0])
		fireEvent.click(screen.getByRole("button", { name: "Apply" }))
		expect(resolveMemoryProposal).toHaveBeenCalledWith(
			expect.objectContaining({ proposalId: "p1", save: true, itemIds: ["remove-0"] }),
		)
	})

	it("titles a removal-only proposal as a cleanup and reports what was removed", () => {
		const proposal: MemoryProposal = {
			...PROPOSAL,
			status: "saved",
			savedCount: 0,
			removedCount: 1,
			items: [{ id: "remove-0", scope: "user", text: "Old habit", importance: "normal", action: "remove" }],
		}
		render(<MemoryProposalRow message={row(proposal)} />)
		expect(screen.getByText("Memory cleanup")).toBeTruthy()
		expect(screen.getByText("Removed 1 item.")).toBeTruthy()
	})

	it("shows the outcome once resolved, without buttons", () => {
		render(<MemoryProposalRow message={row({ ...PROPOSAL, status: "saved", savedCount: 2 })} />)
		expect(screen.getByText("Saved 2 memories.")).toBeTruthy()
		expect(screen.queryByRole("button")).toBeNull()
		expect((screen.getAllByRole("checkbox")[0] as HTMLInputElement).disabled).toBe(true)
	})
})
