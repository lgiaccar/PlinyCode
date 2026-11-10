import { StringRequest } from "@shared/proto/cline/common"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { CiBoardServiceClient } from "@/services/grpc-client"
import ViewHeader from "../common/ViewHeader"
import { AddCiTargetForm } from "./AddCiTargetForm"
import { CiBoardOverview } from "./CiBoardOverview"
import { CiTargetSection } from "./CiTargetSection"
import type { CiBoardFilter } from "./ciBoardFilters"
import { errorText, useCiBoard } from "./useCiBoard"

/**
 * The CI board: pull requests and branches watched together, one dot per
 * pipeline, a free model's summary of what failed, and actions that fix it.
 * See docs/ci-board.md.
 */
const CiBoardView = ({ onDone }: { onDone: () => void }) => {
	const { environment } = useExtensionState()
	const board = useCiBoard()
	const [refreshing, setRefreshing] = useState(false)
	const [filter, setFilter] = useState<CiBoardFilter>("all")
	const [query, setQuery] = useState("")
	const [error, setError] = useState<string>()
	const [now, setNow] = useState(Date.now)
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 60_000)
		return () => clearInterval(timer)
	}, [])

	const refreshAll = async () => {
		setError(undefined)
		setRefreshing(true)
		try {
			await CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: "" }))
		} catch (error) {
			setError(errorText(error))
		} finally {
			setRefreshing(false)
		}
	}

	return (
		<div className="fixed inset-0 flex flex-col">
			<ViewHeader environment={environment} onDone={onDone} title="CI Board" />
			<div className="flex-1 overflow-auto px-4 py-3">
				{!board ? (
					<div className="text-description text-sm">Loading…</div>
				) : board.unavailable ? (
					<div className="text-description text-sm">{board.unavailable}</div>
				) : (
					<>
						<AddCiTargetForm existing={board.targets.map((t) => ({ id: t.id, label: t.label }))} />
						{board.rateLimited && (
							<div className="text-xs text-warning mb-2">
								GitHub's rate limit is running low, so the board checks less often, and failure analysis waits,
								until it resets.
							</div>
						)}
						{board.targets.length === 0 ? (
							<div className="text-description text-sm flex flex-col gap-2">
								<div>
									<span className="codicon codicon-pulse" /> Paste a pull request link, type a branch, or watch
									a repository's open pull requests.
								</div>
								<ul className="list-disc pl-5 text-xs flex flex-col gap-1">
									<li>
										Each pipeline is a dot: green passed, red failed, yellow running, grey no run on the
										latest commit.
									</li>
									<li>
										When something fails, a free model reads the failed runs and says what broke and how
										serious it is.
									</li>
									<li>
										The main button offers the fix that fits: Fix conflicts, Fix build, Recalibrate small test
										deltas, or Fix them all when several things are wrong. Expand a row for a fix per
										pipeline; more actions, and your own prompts, are in the menu beside it.
									</li>
									<li>Auto-watch fixes conflicts and small deltas by itself, in the background, for free.</li>
								</ul>
							</div>
						) : (
							<>
								<CiBoardOverview
									filter={filter}
									onFilter={setFilter}
									onQuery={setQuery}
									onRefresh={refreshAll}
									query={query}
									refreshing={refreshing}
									targets={board.targets}
								/>
								{error && (
									<div className="text-xs text-error mb-2" role="alert">
										{error}
									</div>
								)}
								{board.targets.map((target) => (
									<CiTargetSection filter={filter} key={target.id} now={now} query={query} target={target} />
								))}
							</>
						)}
					</>
				)}
			</div>
		</div>
	)
}

export default CiBoardView
