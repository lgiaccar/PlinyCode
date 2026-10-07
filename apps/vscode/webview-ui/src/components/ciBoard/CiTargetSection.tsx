import { type CiTargetView, UpdateCiTargetRequest } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient } from "@/services/grpc-client"
import { CiActionsEditor } from "./CiActionsEditor"
import { CiItemRow } from "./CiItemRow"
import { AUTONOMY_OPTIONS } from "./ciBoardUtils"
import { errorText } from "./useCiBoard"

const KIND_ICONS: Record<string, string> = {
	pr: "codicon-git-pull-request",
	branch: "codicon-git-branch",
	repo: "codicon-repo",
}

/** A target of the board: its header (autonomy, actions, refresh, remove) and its pull requests. */
export const CiTargetSection = ({ target }: { target: CiTargetView }) => {
	const [editing, setEditing] = useState(false)
	const [refreshing, setRefreshing] = useState(false)
	const [error, setError] = useState<string>()

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

	return (
		<section className="mb-4" data-testid="ci-target">
			<div className="flex items-center gap-1.5 min-w-0">
				<span className={cn("codicon", KIND_ICONS[target.kind] ?? "codicon-repo")} />
				<span className="font-medium truncate flex-1 min-w-0" title={target.remoteUrl}>
					{target.label}
				</span>
				<select
					aria-label="Autonomy"
					className="bg-dropdown-background text-dropdown-foreground border border-dropdown-border rounded text-xs"
					onChange={(e) => update({ autonomy: e.target.value })}
					title={AUTONOMY_OPTIONS.find((o) => o.value === target.autonomy)?.title}
					value={target.autonomy}>
					{AUTONOMY_OPTIONS.map((o) => (
						<option disabled={o.value !== "manual"} key={o.value} title={o.title} value={o.value}>
							{o.label}
						</option>
					))}
				</select>
				{target.kind === "repo" && (
					<select
						aria-label="Whose pull requests"
						className="bg-dropdown-background text-dropdown-foreground border border-dropdown-border rounded text-xs"
						onChange={(e) => update({ prFilter: e.target.value })}
						value={target.prFilter}>
						<option value="mine">Mine</option>
						<option value="all">Everyone's</option>
					</select>
				)}
				<Button
					onClick={() => setEditing(!editing)}
					size="xs"
					title="Actions: the prompts this entry can run"
					variant="ghost">
					<span className="codicon codicon-settings-gear" />
				</Button>
				<Button disabled={refreshing} onClick={refresh} size="xs" title="Check now" variant="ghost">
					<span className={cn("codicon codicon-refresh", refreshing && "codicon-modifier-spin")} />
				</Button>
				<Button onClick={remove} size="xs" title="Remove from the board" variant="ghost">
					<span className="codicon codicon-close" />
				</Button>
			</div>
			{!target.checkout && (
				<div className="text-xs text-description mt-1">
					No folder in this window is a checkout of this repository, so actions cannot run. Open one to run them.
				</div>
			)}
			{editing && <CiActionsEditor actions={target.actions} onDone={() => setEditing(false)} targetId={target.id} />}
			{(error || target.error) && <div className="text-xs text-error break-words mt-1">{error || target.error}</div>}
			{target.loading && target.items.length === 0 && <div className="text-xs text-description mt-1">Checking…</div>}
			{!target.loading && !target.error && target.items.length === 0 && (
				<div className="text-xs text-description mt-1">
					{target.kind === "repo" ? "No open pull requests." : "Nothing to show yet."}
				</div>
			)}
			<div>
				{target.items.map((item) => (
					<CiItemRow actions={target.actions} item={item} key={item.key} targetId={target.id} />
				))}
			</div>
		</section>
	)
}
