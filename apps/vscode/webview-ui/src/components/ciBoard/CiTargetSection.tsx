import { type CiTargetView, UpdateCiTargetRequest } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { CiActionsEditor } from "./CiActionsEditor"
import { CiAutoWatchToggle } from "./CiAutoWatchToggle"
import { CiItemRow } from "./CiItemRow"
import { CiTip } from "./CiTip"
import { isFailing, itemRank } from "./ciBoardUtils"
import { errorText } from "./useCiBoard"

const KIND_ICONS: Record<string, { icon: string; tip: string }> = {
	pr: { icon: "codicon-git-pull-request", tip: "A pull request" },
	branch: { icon: "codicon-git-branch", tip: "A branch: its open pull request, or its pushed head" },
	repo: { icon: "codicon-repo", tip: "A repository's open pull requests" },
}

/** A target of the board: its header (auto-watch, actions, refresh, remove) and its pull requests, worst first. */
export const CiTargetSection = ({ target, failingOnly = false }: { target: CiTargetView; failingOnly?: boolean }) => {
	const [editing, setEditing] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [confirmRemove, setConfirmRemove] = useState(false)
	const [error, setError] = useState<string>()
	const kind = KIND_ICONS[target.kind] ?? KIND_ICONS.repo

	const update = (patch: Partial<UpdateCiTargetRequest>) =>
		CiBoardServiceClient.updateCiTarget(UpdateCiTargetRequest.create({ id: target.id, ...patch })).catch((e) =>
			setError(errorText(e)),
		)

	const refresh = async () => {
		setRefreshing(true)
		try {
			await CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: target.id }))
		} catch (e) {
			setError(errorText(e))
		} finally {
			setRefreshing(false)
		}
	}

	const remove = () =>
		CiBoardServiceClient.removeCiTarget(StringRequest.create({ value: target.id })).catch((e) => setError(errorText(e)))

	const failing = target.items.filter(isFailing).length
	const items = [...target.items].filter((item) => !failingOnly || isFailing(item)).sort((a, b) => itemRank(b) - itemRank(a))

	return (
		<section className="mb-4" data-testid="ci-target">
			<div className="sticky top-0 z-10 flex items-center gap-1.5 min-w-0 py-1 bg-sidebar-background">
				<CiTip tip={kind.tip}>
					<span className={cn("codicon", kind.icon)} />
				</CiTip>
				<CiTip tip={target.remoteUrl}>
					<span className="font-medium truncate flex-1 min-w-0">{target.label}</span>
				</CiTip>
				{failing > 0 && (
					<CiTip tip={`${failing} of ${target.items.length} failing or conflicting`}>
						<span className="rounded-full px-1.5 text-[10px] bg-error/20 text-error flex-shrink-0">{failing}</span>
					</CiTip>
				)}
				<CiAutoWatchToggle
					checked={target.autoWatch}
					disabledReason={target.checkout ? undefined : "Open a checkout of this repository in the window to use it."}
					onChange={(autoWatch) => update({ autoWatch })}
				/>
				{target.kind === "repo" && (
					<CiTip tip="Whose open pull requests to list: yours, or everyone's.">
						<select
							aria-label="Whose pull requests"
							className="bg-dropdown-background text-dropdown-foreground border border-dropdown-border rounded text-xs"
							onChange={(e) => update({ prFilter: e.target.value })}
							value={target.prFilter}>
							<option value="mine">Mine</option>
							<option value="all">Everyone's</option>
						</select>
					</CiTip>
				)}
				<CiTip tip="Edit actions: the prompts this entry can run, their models, and what auto-watch may start.">
					<Button aria-label="Edit actions" onClick={() => setEditing(!editing)} size="xs" variant="ghost">
						<span className="codicon codicon-settings-gear" />
					</Button>
				</CiTip>
				<CiTip tip="Check CI for this entry now">
					<Button aria-label="Refresh" disabled={refreshing} onClick={refresh} size="xs" variant="ghost">
						<span className={cn("codicon codicon-refresh", refreshing && "codicon-modifier-spin")} />
					</Button>
				</CiTip>
				{confirmRemove ? (
					<>
						<Button onClick={remove} size="xs" variant="danger">
							Remove
						</Button>
						<Button onClick={() => setConfirmRemove(false)} size="xs" variant="ghost">
							Keep
						</Button>
					</>
				) : (
					<CiTip tip="Stop watching this entry. Its worktrees and conversations are kept.">
						<Button
							aria-label="Remove from the board"
							onClick={() => setConfirmRemove(true)}
							size="xs"
							variant="ghost">
							<span className="codicon codicon-close" />
						</Button>
					</CiTip>
				)}
			</div>
			{!target.checkout && (
				<div className="text-xs text-description mt-1">
					No folder in this window is a checkout of this repository, so actions cannot run. Open one to run them.
				</div>
			)}
			{editing && (
				<CiActionsEditor
					actions={target.actions}
					onDone={() => setEditing(false)}
					skills={target.skills}
					targetId={target.id}
				/>
			)}
			{(error || target.error) && <div className="text-xs text-error break-words mt-1">{error || target.error}</div>}
			{target.loading && target.items.length === 0 && <div className="text-xs text-description mt-1">Checking…</div>}
			{!target.loading && !target.error && target.items.length === 0 && (
				<div className="text-xs text-description mt-1">
					{target.kind === "repo" ? "No open pull requests." : "Nothing to show yet."}
				</div>
			)}
			{failingOnly && items.length === 0 && target.items.length > 0 && (
				<div className="text-xs text-description mt-1">Nothing failing here.</div>
			)}
			<div>
				{items.map((item) => (
					<CiItemRow item={item} key={item.key} onEditActions={() => setEditing(true)} targetId={target.id} />
				))}
			</div>
		</section>
	)
}
