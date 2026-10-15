import { adoServerSignInMessage } from "@shared/adoServerAuth"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { DevOpsErrorText } from "./DevOpsErrorText"

const mocks = vi.hoisted(() => ({ signInAdoServer: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({
	McpServiceClient: { signInAdoServer: mocks.signInAdoServer },
}))

describe("DevOpsErrorText", () => {
	beforeEach(() => mocks.signInAdoServer.mockReset())

	it("shows a plain error without a sign-in button", () => {
		render(<DevOpsErrorText error="GET /x -> HTTP 500: boom" />)
		expect(screen.getByRole("alert").textContent).toBe("GET /x -> HTTP 500: boom")
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("offers to sign in to the server the error names, then retries", async () => {
		mocks.signInAdoServer.mockResolvedValue({ value: true })
		const onSignedIn = vi.fn()
		render(
			<DevOpsErrorText
				error={`GET /tfs/C/P/_apis/git/repositories/R -> HTTP 401: TF400813. ${adoServerSignInMessage("tfs.example.com")}`}
				onSignedIn={onSignedIn}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: /Sign in to Azure DevOps Server/ }))
		await waitFor(() => expect(onSignedIn).toHaveBeenCalledTimes(1))
		expect(mocks.signInAdoServer.mock.calls[0][0].value).toBe("tfs.example.com")
	})

	it("does not retry when the user cancels the prompt", async () => {
		mocks.signInAdoServer.mockResolvedValue({ value: false })
		const onSignedIn = vi.fn()
		render(<DevOpsErrorText error={adoServerSignInMessage("tfs.example.com")} onSignedIn={onSignedIn} />)
		fireEvent.click(screen.getByRole("button"))
		await waitFor(() => expect(mocks.signInAdoServer).toHaveBeenCalledTimes(1))
		expect(onSignedIn).not.toHaveBeenCalled()
	})
})
