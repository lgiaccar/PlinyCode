import { CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import { describe, expect, it } from "vitest"
import { filteredCiItems, matchesCiStatus } from "./ciBoardFilters"

const ready = (patch: Partial<CiItem> = {}) =>
	CiItem.create({
		key: "one",
		prId: 42,
		title: "Improve mesh import",
		sourceBranch: "feature/import",
		targetBranch: "stage",
		author: "Ada",
		state: "open",
		headSha: "abcdef12",
		mergeState: "clean",
		pipelines: [{ name: "Linux build", color: "green" }],
		...patch,
	})

describe("CI Board filters", () => {
	it("requires the merge gate, not merely green pipeline dots, for CI ready", () => {
		expect(matchesCiStatus(ready(), "ready")).toBe(true)
		for (const patch of [
			{ draft: true },
			{ conversationStatus: "running" },
			{ conversationStatus: "background" },
			{ state: "closed" },
			{ prId: 0 },
			{ headSha: "" },
			{ mergeState: "pending" },
			{ mergeState: "conflicts" },
			{ error: "Refresh failed" },
			{ pipelines: [] },
			{ pipelines: [{ name: "CI", color: "grey", status: "", result: "", runId: 0, url: "" }] },
			{ buildPolicies: [{ evaluationId: "p", name: "CI", expired: true, status: "approved", buildId: 1 }] },
			{ buildPolicies: [{ evaluationId: "p", name: "CI", expired: false, status: "queued", buildId: 1 }] },
		])
			expect(matchesCiStatus(ready(patch), "ready")).toBe(false)
		expect(matchesCiStatus(ready(), "ready", "Repository fetch failed")).toBe(false)
		expect(matchesCiStatus(ready(), "attention", "Repository fetch failed")).toBe(true)
	})

	it("finds expired and queued policies even before a new pipeline run appears", () => {
		const item = ready({
			buildPolicies: [{ evaluationId: "p", name: "Validation", expired: true, status: "queued", buildId: 7 }],
		})
		expect(matchesCiStatus(item, "expired")).toBe(true)
		expect(matchesCiStatus(item, "running")).toBe(true)
		expect(matchesCiStatus(item, "attention")).toBe(true)
		expect(matchesCiStatus(item, "failed")).toBe(false)
	})

	it("combines case-insensitive words across repository, PR, author, branch and pipeline with the selected status", () => {
		const target = CiTargetView.create({ label: "octo/mesh: open PRs", provider: "github", items: [ready()] })
		expect(filteredCiItems(target, "ready", "  MESH #42 ADA stage LINUX ")).toHaveLength(1)
		expect(filteredCiItems(target, "ready", "feature/import abcdef")).toHaveLength(1)
		expect(filteredCiItems(target, "failed", "mesh")).toHaveLength(0)
		expect(filteredCiItems(target, "all", "other-repo")).toHaveLength(0)
	})
})
