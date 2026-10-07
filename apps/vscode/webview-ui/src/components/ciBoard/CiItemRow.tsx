import type { CiActionInfo, CiItem } from "@shared/proto/cline/ci_board"
import { RunCiActionRequest } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient, UiServiceClient } from "@/services/grpc-client"
import { CONVERSATION_LABELS, MERGE_BADGES } from "./ciBoardUtils"
import { PipelineDots } from "./PipelineDots"
import { errorText } from "./useCiBoard"

interface CiItemRowProps {
	targetId: string
	item: CiItem
	actions: CiActionInfo[]
}

/** One pull request or branch: its pipelines, merge state, conversation and actions. */
export const CiItemRow = ({ targetId, item, actions }: CiItemRowProps) => {
	const [actionId, setActionId] = useState(actions[0]?.id ?? "")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string>()
	const action = actions.find((a) => a.id === actionId) ?? actions[0]
	const badge = MERGE_BADGES[item.mergeState]
	const running = item.conversationStatus === "running" || item.conversationStatus === "background"

	const run = async () => {
		if (!action) return
		setBusy(true)
		setError(undefined)
		try {
			await CiBoardServiceClient.runCiAction(
				RunCiActionRequest.create({ targetId, itemKey: item.key, actionId: action.id }),
			)
		} catch (e) {
			setError(errorText(e))
		} finally {
			setBusy(false)
		}
	}

	const openConversation = () =>
		CiBoardServiceClient.openCiConversation(StringRequest.create({ value: item.key })).catch((e) => setError(errorText(e)))

	return (
		<div className="flex flex-col gap-1 py-2 border-b border-panel-border last:border-b-0" data-testid="ci-item">
			<div className="flex items-center gap-2 min-w-0">
				<PipelineDots pipelines={item.pipelines} />
				<span className="flex-1 min-w-0 truncate" title={item.title || item.sourceBranch}>
					{item.prId ? (
						<button
							className="bg-transparent border-0 p-0 text-link cursor-pointer"
							onClick={() =>
								UiServiceClient.openUrl(StringRequest.create({ value: item.url })).catch(console.error)
							}
							type="button">
							#{item.prId}
						</button>
					) : null}{" "}
					{item.title || item.sourceBranch}
				</span>
				{item.draft && <span className="text-xs text-description">Draft</span>}
				{item.state && item.state !== "open" && <span className="text-xs text-description">{item.state}</span>}
				{badge && (
					<span
						className={cn(
							"text-xs rounded px-1.5 py-0.5 flex-shrink-0",
							item.mergeState === "conflicts" ? "bg-error/20 text-error" : "text-description",
						)}
						data-testid="merge-badge"
						title={badge.title}>
						{badge.label}
					</span>
				)}
			</div>
			<div className="flex items-center gap-2 text-xs text-description min-w-0">
				<span className="truncate flex-1 min-w-0">
					{item.sourceBranch}
					{item.targetBranch ? ` → ${item.targetBranch}` : ""}
					{item.author ? ` · ${item.author}` : ""}
				</span>
				{item.conversationId && (
					<button
						className="inline-flex items-center gap-1 bg-transparent border-0 p-0 text-link cursor-pointer flex-shrink-0"
						onClick={openConversation}
						title="Open the conversation the last action started"
						type="button">
						<span
							className={cn(
								"codicon text-[11px]",
								running ? "codicon-loading codicon-modifier-spin" : "codicon-comment",
							)}
						/>
						{CONVERSATION_LABELS[item.conversationStatus] ?? CONVERSATION_LABELS.idle}
						{item.watching && <span className="codicon codicon-eye text-[11px]" title="Watching CI" />}
					</button>
				)}
				{actions.length > 1 && (
					<select
						aria-label="Action"
						className="bg-dropdown-background text-dropdown-foreground border border-dropdown-border rounded text-xs"
						onChange={(e) => setActionId(e.target.value)}
						value={action?.id}>
						{actions.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				)}
				{action && (
					<Button
						disabled={busy || !!item.runBlocked}
						onClick={run}
						size="sm"
						title={item.runBlocked || (running ? "Open the running conversation" : `Run "${action.label}"`)}
						variant="secondary">
						<span className={cn("codicon", busy ? "codicon-loading codicon-modifier-spin" : "codicon-play")} />
						{actions.length > 1 ? "Run" : action.label}
					</Button>
				)}
			</div>
			{(error || item.error) && <div className="text-xs text-error break-words">{error || item.error}</div>}
		</div>
	)
}
