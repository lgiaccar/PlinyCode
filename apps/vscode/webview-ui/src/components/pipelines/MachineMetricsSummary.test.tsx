import type { MachineMetrics } from "@shared/grafana-metrics"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MachineMetricsSummary } from "./MachineMetricsSummary"
import { queryMachineSummary } from "./machine-summary-query"

const mocks = vi.hoisted(() => ({ queryAgentMetrics: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ AgentMonitorServiceClient: mocks }))
let intersection: (entries: { isIntersecting: boolean }[]) => void
const readings = (host = "build-01"): MachineMetrics => ({
	host,
	from: 1000,
	to: 3000,
	stepMs: 1000,
	results: [
		{
			kind: "cpu",
			title: "CPU",
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
		{ kind: "gpu", title: "GPU", error: "No GPU panel configured", series: [] },
		{
			kind: "disk",
			title: "Disk",
			error: "",
			series: ["C:", "D:"].map((volume, i) => ({
				name: "Free",
				unit: "bytes",
				labels: { volume },
				points: [{ time: 3000, value: (i + 1) * 1024 ** 3 }],
			})),
		},
	],
})
const visible = (value = true) => act(() => intersection([{ isIntersecting: value }]))
beforeEach(() => {
	vi.resetAllMocks()
	mocks.queryAgentMetrics.mockImplementation(({ host }) => Promise.resolve({ value: JSON.stringify(readings(host)) }))
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			constructor(callback: typeof intersection) {
				intersection = callback
			}
			observe() {}
			disconnect() {}
		},
	)
})
afterEach(() => {
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

describe("Automatic machine summary", () => {
	it("shows averages, real zero samples, coverage and separate disk volumes without clicking", async () => {
		render(<MachineMetricsSummary hostname="build-01" ready />)
		expect(mocks.queryAgentMetrics).not.toHaveBeenCalled()
		visible()
		expect(await screen.findByText("35.0%")).toBeVisible()
		expect(screen.getByText("Latest 70.0% · 67% coverage")).toBeVisible()
		expect(screen.getByText("1.0 GiB")).toBeVisible()
		expect(screen.getByText("2.0 GiB")).toBeVisible()
		expect(screen.getByText("C:")).toBeVisible()
		expect(screen.getByText("D:")).toBeVisible()
		expect(screen.getByText("Unavailable")).toHaveAttribute("title", "No GPU panel configured")
		expect(screen.queryByRole("button", { name: "Machine metrics", exact: true })).toBeNull()
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "1w" } })
		await waitFor(() =>
			expect(mocks.queryAgentMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ host: "build-01", range: "1w" })),
		)
	})
	it("makes no queries before setup and opens details only on request", async () => {
		const { rerender } = render(<MachineMetricsSummary hostname="build-01" ready={false} />)
		expect(screen.getByText(/Connect Grafana above/)).toBeVisible()
		expect(mocks.queryAgentMetrics).not.toHaveBeenCalled()
		rerender(<MachineMetricsSummary hostname="build-01" ready />)
		visible()
		await screen.findByText("35.0%")
		expect(screen.queryByRole("region", { name: "Machine metrics for build-01" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Details & charts" }))
		expect(await screen.findByRole("region", { name: "Machine metrics for build-01" })).toBeVisible()
	})
	it("polls visible rows, stops offscreen, and marks previous readings after failure", async () => {
		vi.useFakeTimers()
		render(<MachineMetricsSummary hostname="build-01" ready />)
		await act(async () => intersection([{ isIntersecting: true }]))
		expect(mocks.queryAgentMetrics).toHaveBeenCalledTimes(1)
		mocks.queryAgentMetrics.mockRejectedValue(new Error("Grafana unavailable"))
		await act(async () => vi.advanceTimersByTimeAsync(60_000))
		expect(screen.getByRole("status")).toHaveTextContent("Refresh failed — previous readings")
		expect(screen.getByText("35.0%")).toBeVisible()
		visible(false)
		await act(async () => vi.advanceTimersByTimeAsync(120_000))
		expect(mocks.queryAgentMetrics).toHaveBeenCalledTimes(2)
	})
	it("ignores a late response after switching hosts", async () => {
		let resolve!: (value: { value: string }) => void
		mocks.queryAgentMetrics.mockImplementationOnce(
			() =>
				new Promise((done) => {
					resolve = done
				}),
		)
		const { rerender } = render(<MachineMetricsSummary hostname="old" ready />)
		visible()
		rerender(<MachineMetricsSummary hostname="new" ready />)
		await screen.findByText("35.0%")
		await act(async () => resolve({ value: JSON.stringify({ ...readings("old"), results: [] }) }))
		expect(screen.getByText("35.0%")).toBeVisible()
	})
	it("limits automatic queries to three and drops obsolete queued rows", async () => {
		const releases: (() => void)[] = []
		mocks.queryAgentMetrics.mockImplementation(
			({ host }) => new Promise((resolve) => releases.push(() => resolve({ value: JSON.stringify(readings(host)) }))),
		)
		let active = true
		const pending = [0, 1, 2, 3, 4].map((i) => queryMachineSummary(String(i), "24h", () => i !== 3 || active))
		expect(mocks.queryAgentMetrics).toHaveBeenCalledTimes(3)
		active = false
		releases[0]()
		await pending[0]
		await waitFor(() => expect(mocks.queryAgentMetrics).toHaveBeenCalledTimes(4))
		expect(mocks.queryAgentMetrics.mock.calls.map(([request]) => request.host)).toEqual(["0", "1", "2", "4"])
		for (const finish of releases) finish()
		await Promise.all(pending)
	})
})
