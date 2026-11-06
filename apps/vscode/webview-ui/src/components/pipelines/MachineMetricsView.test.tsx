import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { GrafanaSettings } from "./GrafanaSettings"
import { MachineMetricsView } from "./MachineMetricsView"

const mocks = vi.hoisted(() => ({
	queryAgentMetrics: vi.fn(),
	getGrafanaSettings: vi.fn(),
	configureGrafana: vi.fn(),
	setGrafanaToken: vi.fn(),
	removeGrafanaToken: vi.fn(),
	inspectGrafana: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({ AgentMonitorServiceClient: mocks }))
const readings = (host: string) => ({
	value: JSON.stringify({
		host,
		from: 1000,
		to: 3000,
		stepMs: 1000,
		results: [
			{
				kind: "cpu",
				title: "CPU load",
				error: "",
				series: [
					{
						name: "CPU",
						unit: "percent",
						labels: {},
						points: [
							{ time: 1000, value: 0 },
							{ time: 2000, value: null },
							{ time: 3000, value: 70 },
						],
					},
				],
			},
			{ kind: "gpu", title: "GPU load", error: "", series: [] },
		],
	}),
})
const setup = () => ({
	value: JSON.stringify({
		config: { url: "https://grafana.example.com", dashboardUid: "machines", hostVariable: "host", panels: {} },
		hasToken: false,
		panels: [],
	}),
})
beforeEach(() => {
	vi.resetAllMocks()
	mocks.queryAgentMetrics.mockImplementation(({ host }) => Promise.resolve(readings(host)))
	mocks.getGrafanaSettings.mockResolvedValue(setup())
	mocks.configureGrafana.mockResolvedValue(setup())
	mocks.setGrafanaToken.mockResolvedValue(setup())
})
describe("Machine metrics", () => {
	it("loads only after confirmation of the hostname and offers all five ranges", async () => {
		render(<MachineMetricsView hostname="build-01" />)
		expect(mocks.queryAgentMetrics).not.toHaveBeenCalled()
		expect(screen.getAllByRole("option")).toHaveLength(5)
		fireEvent.click(screen.getByRole("button", { name: "Load metrics" }))
		await screen.findByText("Sample average 35.0% · Peak 70.0% · P95 70.0%")
		expect(mocks.queryAgentMetrics).toHaveBeenCalledWith(expect.objectContaining({ host: "build-01", range: "24h" }))
		expect(screen.getByText(/No data returned for this host/)).toBeInTheDocument()
		expect(screen.getByRole("img", { name: /CPU load over/ }).querySelectorAll("circle")).toHaveLength(2)
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "30d" } })
		await waitFor(() => expect(mocks.queryAgentMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ range: "30d" })))
	})
	it("ignores a slow result from a previously selected range", async () => {
		let finish!: (response: { value: string }) => void
		mocks.queryAgentMetrics.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		render(<MachineMetricsView hostname="build-01" />)
		fireEvent.click(screen.getByRole("button", { name: "Load metrics" }))
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "1h" } })
		await screen.findByText(/build-01 · Queried/)
		await act(async () => finish(readings("wrong-old-result")))
		expect(screen.queryByText(/wrong-old-result/)).not.toBeInTheDocument()
	})
	it("shows a connection error without fabricated statistics", async () => {
		mocks.queryAgentMetrics.mockRejectedValue(new Error("Add a Grafana read/query token first."))
		render(<MachineMetricsView hostname="build-01" />)
		fireEvent.click(screen.getByRole("button", { name: "Load metrics" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Add a Grafana read/query token first")
		expect(screen.queryByText(/Sample average/)).not.toBeInTheDocument()
	})
	it("opens setup on demand and sends no token through the webview", async () => {
		render(<GrafanaSettings />)
		expect(mocks.getGrafanaSettings).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Grafana machine metrics…" }))
		await screen.findByDisplayValue("https://grafana.example.com")
		fireEvent.click(screen.getByRole("button", { name: "Enter token…" }))
		await waitFor(() =>
			expect(mocks.setGrafanaToken).toHaveBeenCalledWith(expect.not.objectContaining({ token: expect.anything() })),
		)
		expect(document.querySelector('input[type="password"]')).toBeNull()
	})
})
