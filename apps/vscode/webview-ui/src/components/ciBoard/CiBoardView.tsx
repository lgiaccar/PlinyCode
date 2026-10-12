import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import ViewHeader from "../common/ViewHeader"
import { AddCiTargetForm } from "./AddCiTargetForm"
import { CiTargetSection } from "./CiTargetSection"
import { CiTip } from "./CiTip"
import { isFailing } from "./ciBoardUtils"
import { useCiBoard } from "./useCiBoard"

/**
 * The CI board: pull requests and branches watched together, one dot per
 * pipeline, a free model's summary of what failed, and actions that fix it.
 * See docs/ci-board.md.
 */
const CiBoardView = ({ onDone }: { onDone: () => void }) => {
	const { environment } = useExtensionState()
	const board = useCiBoard()
	const [refreshing, setRefreshing] = useState(false)
	const [failingOnly, setFailingOnly] = useState(false)

	const refreshAll = async () => {
		setRefreshing(true)
		try {
			await CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: "" }))
		} finally {
			setRefreshing(false)
		}
	}

	const items = board?.targets.flatMap((t) => t.items) ?? []
	const conflicts = items.filter((i) => i.mergeState === "conflicts").length
	const failing = items.filter((i) => i.pipelines.some((p) => p.color === "red")).length
	const running = items.filter((i) => i.pipelines.some((p) => p.color === "yellow")).length
	const green = items.filter(
		(i) => !isFailing(i) && i.pipelines.length > 0 && i.pipelines.every((p) => p.color === "green"),
	).length

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
										The main button offers the fix that fits: Fix conflicts, Recalibrate small test deltas, or
										Fix CI. More actions, and your own prompts, are in the menu beside it.
									</li>
									<li>Auto-watch fixes conflicts and small deltas by itself, in the background, for free.</li>
								</ul>
							</div>
						) : (
							<>
								<div className="flex flex-wrap items-center gap-2 mb-1 text-xs" data-testid="ci-board-summary">
									<CiTip tip="Pull requests whose pipelines failed on their latest commit">
										<span className={cn(failing ? "text-error" : "text-description")}>{failing} failing</span>
									</CiTip>
									<span className="text-description">·</span>
									<CiTip tip="Pull requests that do not merge cleanly into their target branch">
										<span className={cn(conflicts ? "text-error" : "text-description")}>
											{conflicts} conflict{conflicts === 1 ? "" : "s"}
										</span>
									</CiTip>
									<span className="text-description">·</span>
									<CiTip tip="Pull requests with pipelines still running">
										<span className="text-description">{running} running</span>
									</CiTip>
									<span className="text-description">·</span>
									<CiTip tip="Pull requests whose every pipeline passed">
										<span className="text-description">{green} green</span>
									</CiTip>
									<span className="flex-1" />
									<CiTip tip="Show only the pull requests that fail or conflict">
										<label className="inline-flex items-center gap-1 text-description cursor-pointer">
											<input
												aria-label="Failing only"
												checked={failingOnly}
												onChange={(e) => setFailingOnly(e.target.checked)}
												type="checkbox"
											/>
											Failing only
										</label>
									</CiTip>
									<CiTip tip="Check every entry now">
										<Button
											aria-label="Refresh all"
											disabled={refreshing}
											onClick={refreshAll}
											size="xs"
											variant="ghost">
											<span
												className={cn("codicon codicon-refresh", refreshing && "codicon-modifier-spin")}
											/>{" "}
											Refresh
										</Button>
									</CiTip>
								</div>
								{board.targets.map((target) => (
									<CiTargetSection failingOnly={failingOnly} key={target.id} target={target} />
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
