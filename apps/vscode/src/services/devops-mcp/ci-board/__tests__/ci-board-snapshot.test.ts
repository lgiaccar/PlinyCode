import { describe, expect, it } from "bun:test"
import { colorOf, diffItems, groupPipelines } from "../ci-board-snapshot"
import type { CiBoardItem, CiColor } from "../types"
import { boardRun, SHA_A, SHA_B } from "./fake-board-provider"

describe("groupPipelines", () => {
	it("shows one dot per pipeline, the newest run winning", () => {
		const pipelines = groupPipelines([
			boardRun(1, "win", "completed", "failure"),
			boardRun(3, "win", "completed", "success"), // a re-run
			boardRun(2, "linux", "in_progress"),
			boardRun(4, "cuda", "completed", "partial"),
		])
		expect(pipelines.map((p) => [p.name, p.color, p.runId])).toEqual([
			["cuda", "red", 4],
			["linux", "yellow", 2],
			["win", "green", 3],
		])
	})

	it("shows pipelines seen before but missing on this commit in grey", () => {
		const pipelines = groupPipelines([boardRun(1, "win", "completed", "success")], ["win", "linux"])
		expect(pipelines.map((p) => [p.name, p.color, p.status])).toEqual([
			["linux", "grey", undefined],
			["win", "green", "completed"],
		])
	})

	it("colors cancelled and skipped runs grey", () => {
		expect(colorOf({ status: "completed", result: "cancelled" })).toBe("grey")
		expect(colorOf({ status: "queued", result: undefined })).toBe("yellow")
		expect(colorOf(undefined)).toBe("grey")
	})
})

const item = (colors: Record<string, CiColor>, extra: Partial<CiBoardItem> = {}): CiBoardItem => ({
	key: "k",
	branch: "feature",
	headSha: SHA_A,
	fork: false,
	pipelines: Object.entries(colors).map(([name, color]) => ({ name, color })),
	...extra,
})

describe("diffItems", () => {
	it("says nothing about the first snapshot", () => {
		expect(diffItems("t", undefined, item({ win: "red" }))).toEqual([])
	})

	it("reports a pipeline turning red once per commit", () => {
		const running = item({ win: "yellow", linux: "green" })
		const failed = item({ win: "red", linux: "green" })
		expect(diffItems("t", running, failed)).toEqual([
			{ targetId: "t", itemKey: "k", kind: "failed", pipelines: ["win"], headSha: SHA_A },
		])
		expect(diffItems("t", failed, failed)).toEqual([])
		// A new push that fails again is a new failure.
		expect(diffItems("t", failed, item({ win: "red" }, { headSha: SHA_B }))[0]?.kind).toBe("failed")
	})

	it("reports a new conflict and a recovery", () => {
		expect(diffItems("t", item({}), item({}, { mergeState: "conflicts" }))[0]?.kind).toBe("conflict")
		expect(diffItems("t", item({}, { mergeState: "conflicts" }), item({}, { mergeState: "conflicts" }))).toEqual([])
		expect(diffItems("t", item({ win: "red" }), item({ win: "green", linux: "grey" }))[0]?.kind).toBe("recovered")
	})
})
