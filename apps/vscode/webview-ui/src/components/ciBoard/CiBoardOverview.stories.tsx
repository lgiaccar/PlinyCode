import { CiItem, CiTargetView } from "@shared/proto/cline/ci_board"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { CiBoardOverview } from "./CiBoardOverview"
import { CiTargetSection } from "./CiTargetSection"
import type { CiBoardFilter } from "./ciBoardFilters"

const now = Date.now()
const base = CiItem.create({
	prId: 42,
	provider: "ado",
	state: "open",
	sourceBranch: "feature/mesh",
	targetBranch: "stage",
	headSha: "abc123456789",
	mergeState: "clean",
	author: "Ada",
	checkedTs: now - 120_000,
	pipelines: [{ name: "Linux build", color: "green", status: "completed", result: "success" }],
})
const target = CiTargetView.create({
	id: "preview",
	kind: "repo",
	label: "octo/mesh: open PRs",
	checkout: "/example/mesh",
	prFilter: "all",
	items: [
		CiItem.create({
			...base,
			key: "expired",
			title: "Reduce mesh allocations",
			expiredBuildPolicies: [{ evaluationId: "p", name: "PR validation" }],
			buildPolicies: [{ evaluationId: "p", name: "PR validation", expired: true, status: "approved" }],
		}),
		CiItem.create({
			...base,
			key: "failed",
			prId: 43,
			title: "Improve import diagnostics",
			pipelines: [{ name: "Windows unit tests", color: "red", status: "completed", result: "failure" }],
		}),
		CiItem.create({ ...base, key: "ready", prId: 44, title: "Improve context preview" }),
		CiItem.create({
			...base,
			key: "running",
			prId: 45,
			title: "Simplify model routing",
			pipelines: [{ name: "macOS E2E", color: "yellow", status: "queued" }],
		}),
	],
})

function OverviewPreview() {
	const [filter, setFilter] = useState<CiBoardFilter>("all")
	const [query, setQuery] = useState("")
	return (
		<div className="p-3 bg-sidebar-background min-h-screen">
			<h2 className="mt-0 text-base">CI Board</h2>
			<CiBoardOverview
				filter={filter}
				onFilter={setFilter}
				onQuery={setQuery}
				onRefresh={() => {}}
				query={query}
				refreshing={false}
				targets={[target]}
			/>
			<CiTargetSection filter={filter} now={now} query={query} target={target} />
		</div>
	)
}

const meta: Meta<typeof OverviewPreview> = {
	title: "Views/CI Board",
	component: OverviewPreview,
	parameters: {
		layout: "fullscreen",
		docs: {
			description: { component: "Fixture data for layout and filter checks. Provider actions require the extension host." },
		},
	},
}
export default meta
export const Overview: StoryObj<typeof OverviewPreview> = {}
