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
	it("shows only compact disk volumes by default and requests no load history", async () => {
		render(<MachineMetricsSummary hostname="build-01" ready />)
		expect(mocks.queryAgentMetrics).not.toHaveBeenCalled()
		visible()
		await screen.findByText("1.0 GiB")
		expect(screen.queryByText("CPU average")).toBeNull()
		expect(screen.queryByText("GPU average")).toBeNull()
		expect(screen.queryByText("Machine load")).toBeNull()
		expect(screen.queryByRole("combobox")).toBeNull()
		expect(mocks.queryAgentMetrics).toHaveBeenCalledWith(expect.objectContaining({ host: "build-01", diskOnly: true }))
		expect(screen.getByText("1.0 GiB")).toHaveClass("text-error")
		expect(screen.getByText("2.0 GiB")).toBeVisible()
		expect(screen.getByText("C:")).toBeVisible()
		expect(screen.getByText("D:")).toBeVisible()
		expect(screen.queryByRole("button", { name: "Machine metrics", exact: true })).toBeNull()
	})
	it("uses the latest disk sample and marks the exact 50 GB boundary correctly", async () => {
		const sample = readings()
		const disk = sample.results.find((result) => result.kind === "disk")!
		disk.series[0].unit = "decbytes"
		disk.series[0].points = [
			{ time: 3000, value: 49e9 },
			{ time: 1000, value: 90e9 },
		]
		disk.series[1].unit = "decbytes"
		disk.series[1].points = [{ time: 3000, value: 50e9 }]
		mocks.queryAgentMetrics.mockResolvedValue({ value: JSON.stringify(sample) })
		render(<MachineMetricsSummary hostname="build-01" ready />)
		visible()
		expect(await screen.findByText("49.0 GB")).toHaveClass("text-error")
		expect(screen.getByText("50.0 GB")).not.toHaveClass("text-error")
		expect(screen.queryByText("90.0 GB")).toBeNull()
	})

	it("makes no queries before setup and opens details only on request", async () => {
		const { rerender } = render(<MachineMetricsSummary hostname="build-01" ready={false} />)
		expect(screen.queryByRole("region")).toBeNull()
		expect(mocks.queryAgentMetrics).not.toHaveBeenCalled()
		rerender(<MachineMetricsSummary hostname="build-01" ready />)
		visible()
		await screen.findByText("1.0 GiB")
		expect(screen.queryByRole("region", { name: "Machine metrics for build-01" })).toBeNull()
		fireEvent.click(screen.getByRole("button", { name: "Details" }))
		expect(await screen.findByRole("region", { name: "Machine metrics for build-01" })).toBeVisible()
		await waitFor(() =>
			expect(mocks.queryAgentMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ diskOnly: false })),
		)
	})
	it("polls visible rows, stops offscreen, and marks previous readings after failure", async () => {
		vi.useFakeTimers()
		render(<MachineMetricsSummary hostname="build-01" ready />)
		await act(async () => intersection([{ isIntersecting: true }]))
		expect(mocks.queryAgentMetrics).toHaveBeenCalledTimes(1)
		mocks.queryAgentMetrics.mockRejectedValue(new Error("Grafana unavailable"))
		await act(async () => vi.advanceTimersByTimeAsync(60_000))
		expect(screen.getByRole("status")).toHaveTextContent("Previous reading")
		expect(screen.getByText("1.0 GiB")).toBeVisible()
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
		await screen.findByText("1.0 GiB")
		await act(async () => resolve({ value: JSON.stringify({ ...readings("old"), results: [] }) }))
		expect(screen.getByText("1.0 GiB")).toBeVisible()
	})
	it("omits generic Value labels and reports missing disk readings without inventing zero", async () => {
		const sample = readings()
		sample.results = [
			{
				kind: "disk",
				title: "Disk",
				error: "",
				series: [{ name: "Value", unit: "bytes", labels: {}, points: [{ time: 3000, value: 0 }] }],
			},
		]
		mocks.queryAgentMetrics.mockResolvedValue({ value: JSON.stringify(sample) })
		const { rerender } = render(<MachineMetricsSummary hostname="build-01" ready />)
		visible()
		expect(await screen.findByText("0.0 B")).toBeVisible()
		expect(screen.queryByText("Value")).toBeNull()
		mocks.queryAgentMetrics.mockResolvedValue({ value: JSON.stringify({ ...sample, results: [] }) })
		rerender(<MachineMetricsSummary hostname="empty" ready />)
		expect(await screen.findByText("Unavailable")).toBeVisible()
		expect(screen.queryByText("0.0 B")).toBeNull()
	})
	it("limits automatic queries to three and drops obsolete queued rows", async () => {
		const releases: (() => void)[] = []
		mocks.queryAgentMetrics.mockImplementation(
			({ host }) => new Promise((resolve) => releases.push(() => resolve({ value: JSON.stringify(readings(host)) }))),
		)
		let active = true
		const pending = [0, 1, 2, 3, 4].map((i) => queryMachineSummary(String(i), () => i !== 3 || active))
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
