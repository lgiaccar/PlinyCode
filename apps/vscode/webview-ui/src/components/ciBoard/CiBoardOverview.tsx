import type { CiTargetView } from "@shared/proto/cline/ci_board"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CI_FILTERS, type CiBoardFilter, matchesCiSearch, matchesCiStatus } from "./ciBoardFilters"

interface Props {
	targets: CiTargetView[]
	filter: CiBoardFilter
	onFilter: (filter: CiBoardFilter) => void
	query: string
	onQuery: (query: string) => void
	refreshing: boolean
	onRefresh: () => void
}

export function CiBoardOverview({ targets, filter, onFilter, query, onQuery, refreshing, onRefresh }: Props) {
	const entries = targets.flatMap((target) => target.items.map((item) => ({ target, item })))
	const searched = entries.filter(({ target, item }) => matchesCiSearch(item, target, query))
	const count = (value: CiBoardFilter) =>
		searched.filter(({ target, item }) => matchesCiStatus(item, value, target.error)).length
	const shown = count(filter)
	const clear = () => {
		onQuery("")
		onFilter("all")
	}
	return (
		<div className="mb-3 flex flex-col gap-2" data-testid="ci-board-summary">
			<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-description">
				<span>
					{entries.length} watched entries ·{" "}
					{entries.filter(({ target, item }) => matchesCiStatus(item, "attention", target.error)).length} need attention
				</span>
				<Button aria-label="Refresh all" disabled={refreshing} onClick={onRefresh} size="xs" variant="ghost">
					<span className={cn("codicon codicon-refresh", refreshing && "codicon-modifier-spin")} /> Refresh
				</Button>
			</div>
			<input
				aria-label="Search CI Board"
				className="w-full min-w-0 rounded border border-input-border bg-input-background px-2 py-1.5 text-sm text-input-foreground"
				onChange={(event) => onQuery(event.target.value)}
				placeholder="Find a PR, repository, branch, or pipeline…"
				type="search"
				value={query}
			/>
			<fieldset aria-label="CI status filters" className="m-0 min-w-0 border-0 p-0 flex flex-wrap gap-1">
				{CI_FILTERS.map(({ id, label }) => (
					<Button
						aria-pressed={filter === id}
						key={id}
						onClick={() => onFilter(id)}
						size="xs"
						variant={filter === id ? "default" : "secondary"}>
						{label} <span>{count(id)}</span>
					</Button>
				))}
			</fieldset>
			<output className="text-xs text-description">
				Showing {shown} of {entries.length} entries.
				{(query || filter !== "all") && (
					<button
						className="ml-2 border-0 bg-transparent p-0 text-link underline cursor-pointer"
						onClick={clear}
						type="button">
						Clear filters
					</button>
				)}
			</output>
			{filter === "ready" && (
				<p className="m-0 text-xs text-description">
					Reported CI checks pass and the merge is clean. Reviews and repository protections still apply; the provider
					rechecks before merging.
				</p>
			)}
			{shown === 0 && entries.length > 0 && (
				<div className="text-sm text-description py-2">No matching pull requests or branches.</div>
			)}
		</div>
	)
}
