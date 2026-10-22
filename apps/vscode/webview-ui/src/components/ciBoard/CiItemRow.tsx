import { type CiItem, CiItemRequest, RequeueExpiredCiBuildRequest } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useCallback, useState } from "react"
import { DevOpsErrorText } from "@/components/common/DevOpsErrorText"
import { cn } from "@/lib/utils"
import { CiBoardServiceClient, UiServiceClient } from "@/services/grpc-client"
import { CiActionBar } from "./CiActionBar"
import { CiAutoBadge } from "./CiAutoBadge"
import { CiCustomPromptPanel } from "./CiCustomPromptPanel"
import { CiItemDetails } from "./CiItemDetails"
import { CiSeverityChip } from "./CiSeverityChip"
import { CiTip } from "./CiTip"
import { CONVERSATION_LABELS, isFailing, MERGE_BADGES, SEVERITY_META } from "./ciBoardUtils"
import { PipelineDots } from "./PipelineDots"
import { errorText, useCiRun } from "./useCiBoard"

interface CiItemRowProps {
	targetId: string
	item: CiItem
	onEditActions: () => void
}

/** One pull request or branch: its pipelines, what failed and how badly, its conversation and its actions. */
export const CiItemRow = ({ targetId, item, onEditActions }: CiItemRowProps) => {
	const [expanded, setExpanded] = useState(false)
	const [customPrompt, setCustomPrompt] = useState(false)
	const [error, setError] = useState<string>()
	const [requeueing, setRequeueing] = useState<string>()
	const onError = useCallback((message: string | undefined) => setError(message), [])
	const { busy, run } = useCiRun(targetId, item.key, onError)
	const badge = MERGE_BADGES[item.mergeState]
	const running = item.conversationStatus === "running" || item.conversationStatus === "background"
	const failing = isFailing(item)
	const triage = item.triage
	const expandable = failing || !!triage || item.pipelines.length > 0 || (item.expiredBuildPolicies?.length ?? 0) > 0
	const severity = triage ? SEVERITY_META[triage.severity] : undefined
	const branches = `${item.sourceBranch}${item.targetBranch ? ` → ${item.targetBranch}` : ""}${item.author ? ` · ${item.author}` : ""}`

	const openConversation = () =>
		CiBoardServiceClient.openCiConversation(StringRequest.create({ value: item.key })).catch((e) => setError(errorText(e)))

	const analyze = () => {
		setError(undefined)
		CiBoardServiceClient.analyzeCiItem(CiItemRequest.create({ targetId, itemKey: item.key })).catch((e) =>
			setError(errorText(e)),
		)
	}
	const requeue = async (evaluationId: string) => {
		setError(undefined)
		setRequeueing(evaluationId)
		try {
			await CiBoardServiceClient.requeueExpiredCiBuild(
				RequeueExpiredCiBuildRequest.create({ targetId, itemKey: item.key, evaluationId }),
			)
		} catch (error) {
			setError(errorText(error))
		} finally {
			setRequeueing(undefined)
		}
	}

	const summary =
		triage?.status === "pending" && !triage.summary
			? "Analyzing the failures with a free model…"
			: triage?.summary ||
				((item.expiredBuildPolicies?.length ?? 0) > 0
					? "Build validation expired; requeue to validate this PR again."
					: failing
						? ""
						: branches)

	return (
		<div
			className={cn(
				"flex flex-col gap-1 my-1 pl-2 pr-1 py-1.5 rounded border border-border-panel border-l-2 hover:bg-list-hover/40",
				!severity && "border-l-border-panel",
			)}
			data-testid="ci-item"
			style={severity && !triage?.stale ? { borderLeftColor: severity.color } : undefined}>
			<div className="flex items-center gap-1.5 min-w-0">
				{expandable ? (
					<CiTip
						tip={expanded ? "Back to the compact view" : "Show each pipeline, what is wrong with it and its own fix"}>
						<button
							aria-expanded={expanded}
							aria-label={expanded ? "Hide details" : "Show details"}
							className="bg-transparent border-0 p-0 cursor-pointer text-description flex-shrink-0"
							data-testid="ci-expand"
							onClick={() => setExpanded(!expanded)}
							type="button">
							<span className={cn("codicon", expanded ? "codicon-chevron-down" : "codicon-chevron-right")} />
						</button>
					</CiTip>
				) : (
					<span className="inline-block w-4 flex-shrink-0" />
				)}
				<CiSeverityChip triage={triage} />
				<PipelineDots pipelines={item.pipelines} />
				<CiTip tip={`${item.title || item.sourceBranch}\n${branches}`}>
					<span className="flex-1 min-w-0 truncate">
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
				</CiTip>
				{item.draft && <span className="text-[11px] text-description flex-shrink-0">Draft</span>}
				{item.state && item.state !== "open" && (
					<span className="text-[11px] text-description flex-shrink-0">{item.state}</span>
				)}
				{badge && (
					<CiTip tip={badge.title}>
						<span
							className={cn(
								"text-[11px] rounded px-1.5 py-0.5 flex-shrink-0",
								item.mergeState === "conflicts" ? "bg-error/20 text-error" : "text-description",
							)}
							data-testid="merge-badge">
							{badge.label}
						</span>
					</CiTip>
				)}
				<CiAutoBadge auto={item.auto} />
				{(item.expiredBuildPolicies?.length ?? 0) > 0 && (
					<span className="text-[11px] rounded px-1.5 py-0.5 bg-warning/20 text-warning" data-testid="ci-expired-badge">
						{item.expiredBuildPolicies.length} Expired
					</span>
				)}
			</div>
			<div className="flex items-center gap-2 text-[11px] text-description min-w-0 pl-5">
				<CiTip tip={summary && summary !== branches ? summary : undefined}>
					<span className="truncate flex-1 min-w-0" data-testid="ci-summary">
						{summary}
					</span>
				</CiTip>
				{item.conversationId && !running && (
					<CiTip tip="Open the conversation the last action started for this pull request">
						<button
							className="inline-flex items-center gap-1 bg-transparent border-0 p-0 text-link cursor-pointer flex-shrink-0"
							onClick={openConversation}
							type="button">
							<span className="codicon codicon-comment text-[11px]" />
							{CONVERSATION_LABELS[item.conversationStatus] ?? CONVERSATION_LABELS.idle}
						</button>
					</CiTip>
				)}
				{item.watching && (
					<CiTip tip="watch_ci is watching CI for that conversation; it wakes the conversation when CI finishes.">
						<span className="codicon codicon-eye text-[11px] flex-shrink-0" />
					</CiTip>
				)}
				<CiActionBar
					busy={busy}
					item={item}
					onCustomPrompt={() => setCustomPrompt(true)}
					onEditActions={onEditActions}
					onError={onError}
					onRun={run}
					targetId={targetId}
				/>
			</div>
			{expanded && (
				<CiItemDetails
					busy={busy}
					item={item}
					onAnalyze={analyze}
					onRequeue={requeue}
					onRun={run}
					requeueing={requeueing}
					runningReason={
						running
							? "A run started from the board is still going for this pull request. Open its conversation to follow it."
							: undefined
					}
				/>
			)}
			{customPrompt && <CiCustomPromptPanel itemKey={item.key} onDone={() => setCustomPrompt(false)} targetId={targetId} />}
			{(error || item.error) && (
				<DevOpsErrorText
					className="text-xs text-error break-words pl-5"
					error={error || item.error || ""}
					onSignedIn={() => {
						setError(undefined)
						CiBoardServiceClient.refreshCiBoard(StringRequest.create({ value: targetId })).catch((e) =>
							setError(errorText(e)),
						)
					}}
				/>
			)}
		</div>
	)
}
