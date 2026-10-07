import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AddCiTargetForm } from "./AddCiTargetForm"

const mocks = vi.hoisted(() => ({
	addCiTarget: vi.fn(),
	refreshCiBoard: vi.fn(),
	listCiRepos: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({ CiBoardServiceClient: mocks }))

const LINK = "https://ado.example.com/tfs/C/P/_git/GPUSurfer/pullrequest/732914"

describe("AddCiTargetForm", () => {
	beforeEach(() => {
		mocks.addCiTarget.mockReset()
		mocks.refreshCiBoard.mockReset().mockResolvedValue({})
		mocks.listCiRepos.mockReset().mockResolvedValue({ repos: [] })
	})

	const submit = () => {
		fireEvent.change(screen.getByLabelText("Pull request link or branch"), { target: { value: LINK } })
		fireEvent.click(screen.getByRole("button", { name: "Watch PR" }))
	}

	it("says when the pull request is already on the board, and checks it again", async () => {
		mocks.addCiTarget.mockResolvedValue({ value: "t1" })
		render(<AddCiTargetForm existing={[{ id: "t1", label: "C/P/GPUSurfer #732914" }]} />)
		submit()
		expect(await screen.findByTestId("add-ci-target-notice")).toHaveTextContent("Already on the board: C/P/GPUSurfer #732914")
		expect(mocks.refreshCiBoard).toHaveBeenCalledWith(expect.objectContaining({ value: "t1" }))
	})

	it("adds a new one without a notice", async () => {
		mocks.addCiTarget.mockResolvedValue({ value: "t2" })
		render(<AddCiTargetForm existing={[{ id: "t1", label: "other" }]} />)
		submit()
		await waitFor(() => expect(mocks.addCiTarget).toHaveBeenCalledWith(expect.objectContaining({ kind: "pr", input: LINK })))
		expect(screen.queryByTestId("add-ci-target-notice")).toBeNull()
		expect(mocks.refreshCiBoard).not.toHaveBeenCalled()
	})
})
