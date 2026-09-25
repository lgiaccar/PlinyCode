import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ServersToggleList from "./ServersToggleList"

let devOpsStatus: Record<string, unknown> | undefined

vi.mock("@/services/grpc-client", () => ({
	McpServiceClient: {
		subscribeToDevOpsServer: (_request: unknown, callbacks: { onResponse: (status: unknown) => void }) => {
			if (devOpsStatus) callbacks.onResponse(devOpsStatus)
			return () => {}
		},
	},
}))

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ navigateToChat: () => {} }),
}))

vi.mock("./server-row/ServerRow", () => ({
	default: ({ server }: { server: { name: string } }) => <div>row:{server.name}</div>,
}))

const running = {
	state: "running",
	tools: ["repo_context", "pr_create"],
	editor: "Cursor",
	integration: "cursor",
	editorRegistered: true,
	enabled: true,
	registerWithEditor: true,
}

describe("ServersToggleList", () => {
	beforeEach(() => {
		devOpsStatus = undefined
	})

	it("lists the built-in DevOps server even when no MCP servers are configured", () => {
		devOpsStatus = running
		render(<ServersToggleList hasTrashIcon={false} isExpandable={false} servers={[]} />)
		expect(screen.getByText("PlinyCode DevOps")).toBeTruthy()
		expect(screen.getByText("Running · 2 tools")).toBeTruthy()
		expect(screen.getByText("No other MCP servers installed")).toBeTruthy()
	})

	it("puts the built-in server before configured servers", () => {
		devOpsStatus = running
		const servers = [{ name: "linear", config: "{}", status: "connected" }] as never
		const { container } = render(<ServersToggleList hasTrashIcon={false} isExpandable={true} servers={servers} />)
		const text = container.textContent ?? ""
		expect(text.indexOf("PlinyCode DevOps")).toBeLessThan(text.indexOf("row:linear"))
		expect(screen.queryByText(/No (other )?MCP servers installed/)).toBeNull()
	})

	it("keeps the plain empty message when the extension reports no built-in server", () => {
		render(<ServersToggleList hasTrashIcon={false} isExpandable={true} servers={[]} />)
		expect(screen.getByText("No MCP servers installed")).toBeTruthy()
	})
})
