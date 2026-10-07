import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import ViewHeader from "../common/ViewHeader"
import { AddCiTargetForm } from "./AddCiTargetForm"
import { CiTargetSection } from "./CiTargetSection"
import { useCiBoard } from "./useCiBoard"

/**
 * The CI board: pull requests and branches watched together, one dot per
 * pipeline, and prompts to run against them. See docs/ci-board.md.
 */
const CiBoardView = ({ onDone }: { onDone: () => void }) => {
	const { environment } = useExtensionState()
	const board = useCiBoard()
	const [refreshing, setRefreshing] = useState(false)

	const refreshAll = async () => {
		setRefreshing(true)
		try {
			await CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: "" }))
		} finally {
			setRefreshing(false)
		}
	}

	return (
		<div className="fixed inset-0 flex flex-col">
			<ViewHeader environment={environment} onDone={onDone} title="CI Board" />
			<div className="flex-1 overflow-auto px-5 py-3">
				{!board ? (
					<div className="text-description text-sm">Loading…</div>
				) : board.unavailable ? (
					<div className="text-description text-sm">{board.unavailable}</div>
				) : (
					<>
						<AddCiTargetForm existing={board.targets.map((t) => ({ id: t.id, label: t.label }))} />
						{board.rateLimited && (
							<div className="text-xs text-warning mb-2">
								GitHub's rate limit is running low, so the board checks less often until it resets.
							</div>
						)}
						{board.targets.length === 0 ? (
							<div className="text-description text-sm">
								Paste a pull request link, type a branch, or watch a repository's open pull requests. Each
								pipeline shows as a dot: green passed, red failed, yellow running, grey no run on the latest
								commit. Run an action to have PlinyCode fix conflicts and failures in a worktree of the branch.
							</div>
						) : (
							<>
								<div className="flex justify-end mb-1">
									<Button
										disabled={refreshing}
										onClick={refreshAll}
										size="xs"
										title="Check everything now"
										variant="ghost">
										<span className={cn("codicon codicon-refresh", refreshing && "codicon-modifier-spin")} />{" "}
										Refresh
									</Button>
								</div>
								{board.targets.map((target) => (
									<CiTargetSection key={target.id} target={target} />
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
