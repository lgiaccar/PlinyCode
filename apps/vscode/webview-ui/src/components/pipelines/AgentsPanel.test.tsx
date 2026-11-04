import { AgentMonitorState, AgentMonitorsState } from "@shared/proto/cline/agent_monitor"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AgentsPanel } from "./AgentsPanel"

const mocks = vi.hoisted(() => ({
	subscribeToAgents: vi.fn(),
	configureAgentMonitor: vi.fn(),
	refreshAgentMonitor: vi.fn(),
	removeAgentMonitor: vi.fn(),
	openUrl: vi.fn(),
	signInAdoServer: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({ AgentMonitorServiceClient: mocks, UiServiceClient: mocks, McpServiceClient: mocks }))
const snapshot = () =>
	AgentMonitorState.create({
		id: "one",
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
				os: "windows",
				utilization: { busyMs: 900_000, observedMs: 3_600_000 },
				capabilities: ["FFI_BUILD_WIN"],
				url: "https://server/agent",
				pipelineName: "Build FFI",
				runName: "20261104.2",
				jobName: "Windows Release",
				jobUrl: "https://server/build",
			},
		],
	})
let receive: (state: AgentMonitorsState) => void
const send = (...pools: AgentMonitorState[]) => receive(AgentMonitorsState.create({ pools }))
beforeEach(() => {
	vi.resetAllMocks()
	mocks.configureAgentMonitor.mockResolvedValue({ value: "one" })
	mocks.refreshAgentMonitor.mockResolvedValue({})
	mocks.removeAgentMonitor.mockResolvedValue({})
	mocks.openUrl.mockResolvedValue({})
	mocks.subscribeToAgents.mockImplementation((_request, handlers) => {
		receive = handlers.onResponse
		send(snapshot())
		return () => {}
	})
})
describe("Agents panel", () => {
	it("shows OS icons and sampled busy-time utilization without inventing missing history", async () => {
		render(<AgentsPanel />)
		expect(await screen.findByRole("img", { name: "Windows" })).toBeInTheDocument()
		expect(screen.getByText("Utilization (24h): 25.0% · 15m busy / 1.0h observed")).toBeInTheDocument()
		const pool = snapshot()
		pool.agents[0].os = "linux"
		pool.agents[0].utilization = undefined
		act(() => send(pool))
		expect(screen.getByRole("img", { name: "Linux" })).toBeInTheDocument()
		expect(screen.getByText(/collecting samples/)).toBeInTheDocument()
		pool.agents[0].os = "unknown"
		act(() => send(pool))
		expect(screen.getByRole("img", { name: "Unknown OS" })).toBeInTheDocument()
	})
	it("explains first-time setup and enables monitoring after a pool URL is entered", async () => {
		mocks.subscribeToAgents.mockImplementation((_request, handlers) => {
			handlers.onResponse(
				AgentMonitorsState.create({
					pools: [
						AgentMonitorState.create({ id: "one", config: { ...snapshot().config, queueUrl: "", enabled: false } }),
					],
				}),
			)
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
		expect(screen.getByText("Run: 20261104.2 · Job: Windows Release")).toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Build FFI" }))
		expect(mocks.openUrl).toHaveBeenCalledWith(expect.objectContaining({ value: "https://server/build" }))
		expect(screen.getByLabelText("Capability filters")).toHaveValue("FFI_BUILD_*")
		expect(screen.getByText(/1 of 408 agents match/)).toBeInTheDocument()
	})
	it("keeps last known values but marks them stale when a refresh fails", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		act(() => send({ ...snapshot(), error: "Network unavailable" }))
		expect(screen.getByRole("alert")).toHaveTextContent("Network unavailable")
		expect(screen.getByRole("status")).toHaveTextContent("Status unknown")
		expect(screen.getByText("Last known: online · Enabled · Busy")).toBeInTheDocument()
	})
	it("preserves unsaved form edits during polling, saves prefix filters, and stops the saved target", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		fireEvent.change(screen.getByLabelText("Capability filters"), { target: { value: "BUILD_CPU, FFI_BUILD_*" } })
		act(() => send(snapshot()))
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
	it("switches pools without losing draft edits and targets refresh, stop, and removal by ID", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		const second = AgentMonitorState.create({
			...snapshot(),
			id: "two",
			poolName: "LinuxPool",
			agents: [],
			config: { ...snapshot().config, queueUrl: "https://server/collection/project/_settings/agentqueues?queueId=22" },
		})
		act(() => send(snapshot(), second))
		fireEvent.change(screen.getByRole("textbox", { name: "Capability filters" }), { target: { value: "MY_DRAFT" } })
		fireEvent.change(screen.getByRole("combobox", { name: "Agent pool" }), { target: { value: "two" } })
		expect(screen.getByRole("textbox", { name: "Agent-pool URL" })).toHaveValue(second.config!.queueUrl)
		fireEvent.click(screen.getByRole("button", { name: "Refresh", exact: true }))
		await waitFor(() => expect(mocks.refreshAgentMonitor).toHaveBeenCalledWith(expect.objectContaining({ value: "two" })))
		fireEvent.click(screen.getByRole("button", { name: "Stop monitoring" }))
		await waitFor(() =>
			expect(mocks.configureAgentMonitor).toHaveBeenCalledWith(expect.objectContaining({ id: "two", enabled: false })),
		)
		fireEvent.click(screen.getByRole("button", { name: "Remove pool" }))
		await waitFor(() => expect(mocks.removeAgentMonitor).toHaveBeenCalledWith(expect.objectContaining({ value: "two" })))
		act(() => send(snapshot()))
		expect(screen.getByRole("textbox", { name: "Capability filters" })).toHaveValue("MY_DRAFT")
	})
	it("adds a pool without replacing the existing monitor", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		fireEvent.click(screen.getByRole("button", { name: "Add pool" }))
		expect(screen.getByRole("textbox", { name: "Agent-pool URL" })).toHaveValue("")
		const queueUrl = "https://server/collection/project/_settings/agentqueues?queueId=22"
		fireEvent.change(screen.getByRole("textbox", { name: "Agent-pool URL" }), { target: { value: queueUrl } })
		mocks.configureAgentMonitor.mockImplementation(async (config) => {
			send(snapshot(), AgentMonitorState.create({ id: "two", config, poolName: "Second pool" }))
			return { value: "two" }
		})
		fireEvent.click(screen.getByRole("button", { name: "Start monitoring" }))
		await waitFor(() =>
			expect(mocks.configureAgentMonitor).toHaveBeenCalledWith(
				expect.objectContaining({ id: "", queueUrl, enabled: true }),
			),
		)
		await waitFor(() => expect(screen.getByRole("combobox", { name: "Agent pool" })).toHaveValue("two"))
		expect(screen.getAllByRole("option", { name: /Monitoring/ })).toHaveLength(2)
	})
	it("shows an honest fallback for missing pipeline metadata and searches pipeline names", async () => {
		render(<AgentsPanel />)
		await screen.findByText("build-01")
		fireEvent.change(screen.getByRole("textbox", { name: "Search agents or pipelines" }), { target: { value: "build ffi" } })
		expect(screen.getByText("build-01")).toBeInTheDocument()
		fireEvent.change(screen.getByRole("textbox", { name: "Search agents or pipelines" }), { target: { value: "" } })
		const pool = snapshot()
		pool.agents[0].pipelineName = ""
		pool.agents[0].jobUrl = ""
		act(() => send(pool))
		expect(screen.getByText("Pipeline name unavailable")).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Pipeline name unavailable" })).not.toBeInTheDocument()
	})
})
