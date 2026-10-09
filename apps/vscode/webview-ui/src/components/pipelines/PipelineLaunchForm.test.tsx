import { PipelineLaunchInfo } from "@shared/proto/cline/pipeline"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { PipelineLaunchForm } from "./PipelineLaunchForm"
import { PipelineRunRow } from "./PipelineRunRow"

const mocks = vi.hoisted(() => ({
	listCiRepos: vi.fn(),
	listPipelines: vi.fn(),
	getPipelineInputs: vi.fn(),
	queuePipelineRun: vi.fn(),
	associatePipelineRun: vi.fn(),
	openUrl: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({ CiBoardServiceClient: mocks, PipelineServiceClient: mocks, UiServiceClient: mocks }))

describe("Pipeline launch controls", () => {
	beforeEach(() => {
		vi.resetAllMocks()
		mocks.listCiRepos.mockResolvedValue({ repos: [{ root: "/workspace", currentBranch: "main", provider: "github" }] })
		mocks.listPipelines.mockResolvedValue({
			pipelines: [{ id: 3, name: "Deploy", url: "https://github.com/o/r/actions" }],
			defaultRef: "main",
		})
		mocks.getPipelineInputs.mockResolvedValue({
			revision: "sha",
			limitations: [],
			parameters: [
				{ name: "enabled", label: "Enabled", type: "boolean", defaultJson: "false", optionsJson: [], required: false },
				{ name: "count", label: "Count", type: "number", defaultJson: "0", optionsJson: [], required: false },
				{
					name: "target",
					label: "Target",
					type: "choice",
					defaultJson: '"dev"',
					optionsJson: ['"dev"', '"prod"'],
					required: true,
				},
			],
		})
		mocks.queuePipelineRun.mockResolvedValue({ value: "id" })
		mocks.associatePipelineRun.mockResolvedValue({})
	})

	it("renders typed inputs and queues false and zero without losing their types", async () => {
		render(<PipelineLaunchForm />)
		expect(await screen.findByLabelText("Enabled")).not.toBeChecked()
		expect(screen.getByLabelText("Count")).toHaveValue(0)
		fireEvent.change(screen.getByLabelText("Target *"), { target: { value: '"prod"' } })
		fireEvent.click(screen.getByRole("button", { name: "Run" }))
		await waitFor(() => expect(mocks.queuePipelineRun).toHaveBeenCalledTimes(1))
		const request = mocks.queuePipelineRun.mock.calls[0][0]
		expect(JSON.parse(request.inputsJson)).toEqual({ enabled: false, count: 0, target: "prod" })
		expect(request).toMatchObject({ repoRoot: "/workspace", pipelineId: 3, ref: "main", revision: "sha" })
		expect(await screen.findByText("Launch recorded.")).toBeInTheDocument()
	})

	it("rediscovers parameters for a new ref and blocks unsupported pipelines", async () => {
		render(<PipelineLaunchForm />)
		await screen.findByLabelText("Enabled")
		mocks.getPipelineInputs.mockResolvedValue({
			revision: "other",
			parameters: [],
			limitations: ["Unsupported stepList parameter."],
		})
		fireEvent.change(screen.getByLabelText("Branch or ref"), { target: { value: "feature" } })
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
		expect(await screen.findByText("Unsupported stepList parameter.")).toBeInTheDocument()
		expect(mocks.getPipelineInputs).toHaveBeenLastCalledWith(expect.objectContaining({ ref: "feature" }))
		expect(screen.getByRole("button", { name: "Run" })).toBeDisabled()
	})

	it("retains the request ID on transport errors so retry cannot duplicate a launch", async () => {
		mocks.queuePipelineRun.mockRejectedValueOnce(new Error("Connection lost"))
		render(<PipelineLaunchForm />)
		await screen.findByLabelText("Enabled")
		fireEvent.click(screen.getByRole("button", { name: "Run" }))
		expect(await screen.findByRole("alert")).toHaveTextContent("Connection lost")
		fireEvent.click(screen.getByRole("button", { name: "Run" }))
		await waitFor(() => expect(mocks.queuePipelineRun).toHaveBeenCalledTimes(2))
		expect(mocks.queuePipelineRun.mock.calls[0][0].id).toBe(mocks.queuePipelineRun.mock.calls[1][0].id)
	})

	it("allows explicit linking for accepted launches without a run ID", async () => {
		render(
			<PipelineRunRow
				launch={PipelineLaunchInfo.create({
					id: "launch",
					pipelineName: "Deploy",
					ref: "main",
					provider: "github",
					created: Date.now(),
					status: "awaiting_identification",
					needsAssociation: true,
				})}
			/>,
		)
		expect(screen.getByText("Awaiting run ID")).toBeInTheDocument()
		fireEvent.change(screen.getByLabelText("Run ID for Deploy"), { target: { value: "42" } })
		fireEvent.click(screen.getByRole("button", { name: "Link run" }))
		await waitFor(() =>
			expect(mocks.associatePipelineRun).toHaveBeenCalledWith(expect.objectContaining({ id: "launch", runId: 42 })),
		)
	})
})
