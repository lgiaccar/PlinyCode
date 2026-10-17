import { PipelineRunAction } from "@shared/proto/cline/pipeline"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setPipelineManager } from "@/services/devops-mcp/builtin-mcp-registry"
import type { PipelineManager } from "@/services/devops-mcp/pipelines/pipeline-manager"
import type { PipelineLaunch } from "@/services/devops-mcp/pipelines/pipeline-run-store"
import type { Controller } from ".."
import { cancelPipelineRun } from "./cancelPipelineRun"
import { pipelineHistory } from "./pipeline-view"
import { rerunPipelineRun } from "./rerunPipelineRun"

const controller = {} as Controller

const launch = (overrides: Partial<PipelineLaunch>): PipelineLaunch => ({
	id: "launch",
	repoRoot: "/workspace",
	remoteUrl: "https://github.com/o/r",
	provider: "github",
	pipeline: { id: 1, name: "Build", url: "https://github.com/o/r/actions" },
	ref: "main",
	revision: "sha",
	created: 1,
	state: "accepted",
	runId: 42,
	url: "https://github.com/o/r/actions/runs/42",
	...overrides,
})

afterEach(() => setPipelineManager(undefined))

describe("Pipelines view run actions", () => {
	it("cancels and reruns through the pipeline manager", async () => {
		const manager = { cancel: vi.fn().mockResolvedValue(undefined), rerun: vi.fn().mockResolvedValue({}) }
		setPipelineManager(manager as unknown as PipelineManager)
		await cancelPipelineRun(controller, PipelineRunAction.create({ id: "a" }))
		await rerunPipelineRun(controller, PipelineRunAction.create({ id: "b", failedOnly: true }))
		expect(manager.cancel).toHaveBeenCalledWith("a")
		expect(manager.rerun).toHaveBeenCalledWith("b", true)
	})

	it("passes the manager's refusal back to the view", async () => {
		setPipelineManager({
			cancel: vi.fn().mockRejectedValue(new Error("This run has already finished.")),
		} as unknown as PipelineManager)
		await expect(cancelPipelineRun(controller, PipelineRunAction.create({ id: "a" }))).rejects.toThrow("already finished")
		setPipelineManager(undefined)
		await expect(rerunPipelineRun(controller, PipelineRunAction.create({ id: "a" }))).rejects.toThrow("still starting")
	})

	it("offers cancel while a run is unfinished and rerun once it has finished", () => {
		setPipelineManager({
			view: () => [
				launch({ id: "running", run: undefined, origin: "agent" }),
				launch({ id: "done", run: { status: "completed", result: "failure" } as PipelineLaunch["run"], origin: "rerun" }),
				launch({ id: "unlinked", runId: undefined }),
				launch({ id: "old" }),
			],
		} as unknown as PipelineManager)
		const rows = Object.fromEntries(pipelineHistory().launches.map((row) => [row.id, row]))
		expect([rows.running.canCancel, rows.running.canRerun, rows.running.origin]).toEqual([true, false, "agent"])
		expect([rows.done.canCancel, rows.done.canRerun, rows.done.origin]).toEqual([false, true, "rerun"])
		expect([rows.unlinked.canCancel, rows.unlinked.canRerun]).toEqual([false, false])
		expect(rows.old.origin).toBe("view")
	})
})
