import { AgentMonitorState } from "@shared/proto/cline/agent_monitor"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentsPanel } from "./AgentsPanel"

const mocks = vi.hoisted(() => ({
	subscribeToAgents: vi.fn(),
	configureAgentMonitor: vi.fn(),
	refreshAgentMonitor: vi.fn(),
	openUrl: vi.fn(),
	signInAdoServer: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({ AgentMonitorServiceClient: mocks, UiServiceClient: mocks, McpServiceClient: mocks }))
const snapshot = () =>
	AgentMonitorState.create({
		config: {
			queueUrl: "https://server/collection/project/_settings/agentqueues?queueId=21",
			capabilities: ["FFI_BUILD_*"],
			authentication: "windows",
			enabled: true,
			notify: true,
		},
		poolName: "BuildPool",
		updated: 1234567,
		total: 408,
		agents: [
			{
				id: 1,
				name: "build-01",
				status: "online",
				enabled: true,
				busy: true,
				capabilities: ["FFI_BUILD_WIN"],
				url: "https://server/agent",
				jobName: "Build FFI",
				jobUrl: "https://server/build",
			},
		],
	})
let receive: (state: AgentMonitorState) => void
beforeEach(() => {
	vi.resetAllMocks()
	mocks.configureAgentMonitor.mockResolvedValue({})
	mocks.refreshAgentMonitor.mockResolvedValue({})
	mocks.subscribeToAgents.mockImplementation((_request, handlers) => {
		receive = handlers.onResponse
		receive(snapshot())
		return () => {}
	})
})
describe("Agents panel", () => {
	it("explains first-time setup and enables monitoring after a pool URL is entered", async () => {
		mocks.subscribeToAgents.mockImplementation((_request, handlers) => {
			handlers.onResponse(AgentMonitorState.create({ config: { ...snapshot().config, queueUrl: "", enabled: false } }))
			return () => {}
		})
		render(<AgentsPanel />)
		const start = await screen.findByRole("button", { name: "Start monitoring" })
		expect(start).toBeDisabled()
		expect(screen.getByLabelText("Agent-pool URL")).toHaveValue("")
		expect(screen.getByText(/Paste your agent-pool URL to enable Start monitoring/)).toBeInTheDocument()
		const queueUrl = "https://ado.example/tfs/Collection/Project/_settings/agentqueues?queueId=21"
		fireEvent.change(screen.getByLabelText("Agent-pool URL"), { target: { value: queueUrl } })
		expect(start).toBeEnabled()
		fireEvent.click(start)
		await waitFor(() =>
			expect(mocks.configureAgentMonitor).toHaveBeenCalledWith(expect.objectContaining({ queueUrl, enabled: true })),
		)
	})
	it("shows live status, current job, and saved filters", async () => {
		render(<AgentsPanel />)
		expect(await screen.findByText("build-01")).toBeInTheDocument()
		expect(screen.getByText("online · Enabled · Busy")).toBeInTheDocument()
		expect(screen.getByText("Build FFI")).toBeInTheDocument()
		expect(screen.getByLabelText("Capability filters")).toHaveValue("FFI_BUILD_*")
		expect(screen.getByText(/1 of 408 agents match/)).toBeInTheDocument()
	})
	it("keeps last known values but marks them stale when a refresh fails", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		act(() => receive({ ...snapshot(), error: "Network unavailable" }))
		expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable")
		expect(screen.getByRole("status")).toHaveTextContent("Status unknown")
		expect(screen.getByText("Last known: online · Enabled · Busy")).toBeInTheDocument()
	})
	it("preserves unsaved form edits during polling, saves prefix filters, and stops the saved target", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		fireEvent.change(screen.getByLabelText("Capability filters"), { target: { value: "BUILD_CPU, FFI_BUILD_*" } })
		act(() => receive(snapshot()))
		expect(screen.getByLabelText("Capability filters")).toHaveValue("BUILD_CPU, FFI_BUILD_*")
		fireEvent.click(screen.getByRole("button", { name: "Save monitor" }))
		await waitFor(() =>
			expect(mocks.configureAgentMonitor).toHaveBeenCalledWith(
				expect.objectContaining({ capabilities: ["BUILD_CPU", "FFI_BUILD_*"], enabled: true }),
			),
		)
		fireEvent.click(screen.getByRole("button", { name: "Stop monitoring" }))
		await waitFor(() =>
			expect(mocks.configureAgentMonitor).toHaveBeenLastCalledWith(
				expect.objectContaining({ enabled: false, capabilities: ["FFI_BUILD_*"] }),
			),
		)
	})
})
