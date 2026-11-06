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
	discoverGrafana: vi.fn(),
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
	mocks.setGrafanaToken.mockResolvedValue({ value: JSON.stringify({ ...JSON.parse(setup().value), hasToken: true }) })
	mocks.discoverGrafana.mockResolvedValue({
		value: JSON.stringify({
			...JSON.parse(setup().value),
			hasToken: true,
			config: { ...JSON.parse(setup().value).config, panels: { cpu: 1 } },
		}),
	})
})
describe("Machine metrics", () => {
	it("loads the agent machine automatically and offers all five ranges", async () => {
		render(<MachineMetricsView hostname="build-01" />)
		expect(screen.getAllByRole("option")).toHaveLength(5)
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
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "1h" } })
		await screen.findByText(/build-01 · Queried/)
		await act(async () => finish(readings("wrong-old-result")))
		expect(screen.queryByText(/wrong-old-result/)).not.toBeInTheDocument()
	})
	it("shows a connection error without fabricated statistics", async () => {
		mocks.queryAgentMetrics.mockRejectedValue(new Error("Add a Grafana read/query token first."))
		render(<MachineMetricsView hostname="build-01" />)
		expect(await screen.findByRole("alert")).toHaveTextContent("Add a Grafana read/query token first")
		expect(screen.queryByText(/Sample average/)).not.toBeInTheDocument()
	})
	it("keeps the first-install server field visible while typing and stops on cancelled token entry", async () => {
		mocks.getGrafanaSettings.mockResolvedValue({
			value: JSON.stringify({
				...JSON.parse(setup().value),
				config: { url: "", dashboardUid: "", hostVariable: "host", panels: {} },
			}),
		})
		mocks.setGrafanaToken.mockResolvedValue({ value: JSON.stringify({ ...JSON.parse(setup().value), cancelled: true }) })
		render(<GrafanaSettings />)
		fireEvent.click(screen.getByRole("button", { name: "Grafana machine metrics…" }))
		const server = await screen.findByLabelText("Grafana server URL")
		fireEvent.change(server, { target: { value: "https://grafana.example.com" } })
		expect(screen.getByLabelText("Grafana server URL")).toBeVisible()
		fireEvent.click(screen.getByRole("button", { name: "Enter token and connect…" }))
		await waitFor(() => expect(mocks.setGrafanaToken).toHaveBeenCalled())
		expect(mocks.discoverGrafana).not.toHaveBeenCalled()
	})
	it("uses a saved token without prompting and keeps manual fields under Advanced setup", async () => {
		mocks.getGrafanaSettings.mockResolvedValue({ value: JSON.stringify({ ...JSON.parse(setup().value), hasToken: true }) })
		mocks.configureGrafana.mockResolvedValue({ value: JSON.stringify({ ...JSON.parse(setup().value), hasToken: true }) })
		render(<GrafanaSettings />)
		fireEvent.click(screen.getByRole("button", { name: "Grafana machine metrics…" }))
		await screen.findByText(/A token is stored/)
		fireEvent.click(screen.getByRole("button", { name: "Connect automatically" }))
		await screen.findByText(/Connected. Dashboard and metric panels/)
		expect(mocks.setGrafanaToken).not.toHaveBeenCalled()
		expect(screen.queryByLabelText("Dashboard UID")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Advanced setup" }))
		expect(screen.getByLabelText(/Dashboard UID/)).toBeVisible()
	})
	it("opens setup on demand and sends no token through the webview", async () => {
		render(<GrafanaSettings />)
		expect(mocks.getGrafanaSettings).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Grafana machine metrics…" }))
		await screen.findByText(/No token stored/)
		expect(screen.queryByLabelText("Dashboard UID")).toBeNull()
		expect(screen.queryByLabelText("Grafana server URL")).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Enter token and connect…" }))
		await waitFor(() =>
			expect(mocks.setGrafanaToken).toHaveBeenCalledWith(expect.not.objectContaining({ token: expect.anything() })),
		)
		await screen.findByText(/Connected. Dashboard and metric panels/)
		expect(mocks.discoverGrafana).toHaveBeenCalled()
		expect(screen.getByText(/Available: CPU load/)).toBeInTheDocument()
		expect(document.querySelector('input[type="password"]')).toBeNull()
	})
})
