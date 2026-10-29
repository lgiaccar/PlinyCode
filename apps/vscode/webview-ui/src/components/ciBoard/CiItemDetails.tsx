import type { CiFailedStep, CiItem, CiPipeline, CiPipelineFix, CiPipelineTriage } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { CATEGORY_META, DOT_COLORS, timeAgo } from "./ciBoardUtils"
import { runKey } from "./useCiBoard"

const ERRORS_SHOWN = 3
const EXCERPT_LINES = 12

const link = "bg-transparent border-0 p-0 text-link cursor-pointer inline-flex items-center gap-1"

/** What the details need to start a fix and show that one is starting or running. */
interface RunProps {
	/** The `runKey` of the run being started, if any. */
	busy?: string
	/** Why no fix can start now (a run is going); empty when one can. */
	runningReason?: string
	onRun: (actionId: string, pipeline?: string) => Promise<void>
}

const StepDetail = ({ step }: { step: CiFailedStep }) => {
	const [allErrors, setAllErrors] = useState(false)
	const [fullLog, setFullLog] = useState(false)
	const errors = allErrors ? step.errors : step.errors.slice(0, ERRORS_SHOWN)
	const lines = step.excerpt ? step.excerpt.split("\n") : []
	const log = fullLog ? lines : lines.slice(-EXCERPT_LINES)
	return (
		<div className="ml-3 mt-1">
			<div className="text-description">
				{step.job} › <span className="text-foreground">{step.step}</span>
			</div>
			{errors.map((error, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: errors repeat and have no id
				<div className="font-mono text-[11px] text-error break-words whitespace-pre-wrap" key={i}>
					{error}
				</div>
			))}
			{step.errors.length > ERRORS_SHOWN && (
				<button className={link} onClick={() => setAllErrors(!allErrors)} type="button">
					{allErrors ? "Show fewer" : `Show ${step.errors.length - ERRORS_SHOWN} more`}
				</button>
			)}
			{log.length > 0 && (
				<>
					<pre className="mt-1 max-h-60 overflow-auto rounded bg-code-block-background p-1.5 text-[11px] whitespace-pre-wrap break-words">
						{log.join("\n")}
					</pre>
					{lines.length > EXCERPT_LINES && (
						<button className={link} onClick={() => setFullLog(!fullLog)} type="button">
							{fullLog ? "Show the last lines only" : `Show all ${lines.length} lines`}
						</button>
					)}
				</>
			)}
		</div>
	)
}

/** A pipeline that did not fail: OK, running, queued, or not run. */
function statusOf(p: CiPipeline): { label: string; tip: string } {
	switch (p.color) {
		case "green":
			return { label: "OK", tip: "Passed on the pull request's head commit." }
		case "yellow":
			return p.status === "queued"
				? { label: "Queued", tip: "Waiting for an agent." }
				: { label: "Running", tip: "Still running on the pull request's head commit." }
		case "red":
			return { label: "Failed", tip: "Failed on the pull request's head commit." }
		default:
			return p.status
				? { label: p.result || "Not run", tip: "Cancelled or skipped." }
				: { label: "Not run", tip: "No run on the head commit yet: it has not started, or a path filter skipped it." }
	}
}

/**
 * A problem's fix: the single fix that fits it, and a menu of the other
 * actions that can run on the pipeline alone, for when the triage is wrong.
 */
const FixButton = ({ item, fix, busy, runningReason, onRun }: RunProps & { item: CiItem; fix: CiPipelineFix }) => {
	const [open, setOpen] = useState(false)
	const ref = useRef<HTMLDivElement>(null)
	const disabledReason = runningReason || fix.disabledReason
	const label = (id: string) => item.actions.find((a) => a.actionId === id)?.label ?? id
	const starting = !!busy

	useEffect(() => {
		if (!open) return
		const onDown = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
		}
		document.addEventListener("mousedown", onDown)
		return () => document.removeEventListener("mousedown", onDown)
	}, [open])

	if (!fix.actionId && fix.alternatives.length === 0) {
		return null
	}
	const run = (actionId: string) => {
		setOpen(false)
		void onRun(actionId, fix.pipeline || undefined)
	}
	return (
		<div className="relative inline-flex flex-shrink-0" data-testid="ci-fix" ref={ref}>
			{fix.actionId && (
				<CiTip tip={disabledReason || fix.tooltip} wrap={!!disabledReason}>
					<Button
						className={cn(fix.alternatives.length > 0 && "rounded-r-none")}
						data-testid="ci-fix-button"
						disabled={starting || !!disabledReason}
						onClick={() => run(fix.actionId)}
						size="sm"
						variant="secondary">
						<span
							className={cn(
								"codicon",
								busy === runKey(fix.actionId, fix.pipeline)
									? "codicon-loading codicon-modifier-spin"
									: "codicon-wrench",
							)}
						/>
						{fix.label}
					</Button>
				</CiTip>
			)}
			{fix.alternatives.length > 0 && (
				<CiTip tip={`Other actions on ${fix.pipeline} alone`}>
					<Button
						aria-expanded={open}
						aria-haspopup="menu"
						aria-label={`Other actions on ${fix.pipeline}`}
						className={cn(fix.actionId ? "rounded-l-none border-l border-l-button-separator px-1" : "")}
						disabled={starting || !!disabledReason}
						onClick={() => setOpen(!open)}
						size="sm"
						variant="secondary">
						<span className="codicon codicon-chevron-down" />
						{!fix.actionId && "Actions"}
					</Button>
				</CiTip>
			)}
			{open && (
				<div
					className="absolute right-0 top-[calc(100%+4px)] z-50 w-56 max-w-[80vw] flex flex-col py-1 rounded border border-menu-border bg-menu text-xs shadow-lg"
					onKeyDown={(e) => e.key === "Escape" && setOpen(false)}
					role="menu">
					{fix.alternatives.map((id) => (
						<button
							className="w-full text-left px-2 py-1 bg-transparent border-0 text-menu-foreground cursor-pointer hover:bg-list-hover focus:bg-list-hover focus:outline-none"
							key={id}
							onClick={() => run(id)}
							role="menuitem"
							type="button">
							<span className="font-medium">{label(id)}</span>{" "}
							<span className="text-description">on {fix.pipeline} only</span>
						</button>
					))}
				</div>
			)}
		</div>
	)
}

interface PipelineRowProps extends RunProps {
	item: CiItem
	/** Undefined for the merge-conflict row. */
	pipeline?: CiPipeline
	fix?: CiPipelineFix
	triage?: CiPipelineTriage
}

/** One line of the vertical view: a pipeline (or the merge), what is wrong with it, and its fix. */
const PipelineRow = ({ item, pipeline, fix, triage, ...run }: PipelineRowProps) => {
	const name = pipeline?.name ?? `Merge into ${item.targetBranch || "the target branch"}`
	const status = pipeline ? statusOf(pipeline) : undefined
	const category = fix ? CATEGORY_META[fix.category] : undefined
	const problem = fix?.problem ?? status?.label ?? ""
	const problemTip = (category?.tip ?? status?.tip) || undefined
	const color = fix ? "red" : (pipeline?.color ?? "grey")
	const fixing =
		(item.conversationStatus === "running" || item.conversationStatus === "background") &&
		!!item.runActionId &&
		item.runPipeline === (pipeline?.name ?? "") &&
		(!!item.runPipeline || item.runActionId === fix?.actionId)
	return (
		<div className="py-1.5 border-t border-border-panel first:border-t-0" data-testid="ci-pipeline-detail">
			<div className="flex items-center gap-1.5 min-w-0">
				<span
					className={cn(
						"inline-block size-2 rounded-full flex-shrink-0",
						color === "yellow" && "motion-safe:animate-pulse",
						color === "grey" && "opacity-50",
					)}
					style={{ background: DOT_COLORS[color] ?? DOT_COLORS.grey }}
				/>
				<span className={cn("truncate min-w-0", fix && "font-medium")}>{name}</span>
				<span className="codicon codicon-arrow-right text-[11px] text-description flex-shrink-0" />
				<CiTip tip={problemTip}>
					<span
						className={cn(
							"rounded px-1 text-[10px] flex-shrink-0",
							fix ? "bg-error/15 text-error" : "border border-border-panel text-description",
						)}
						data-testid="ci-pipeline-problem">
						{problem}
					</span>
				</CiTip>
				{fixing && (
					<span className="inline-flex items-center gap-1 text-[10px] text-description flex-shrink-0">
						<span className="codicon codicon-loading codicon-modifier-spin text-[10px]" /> fixing
					</span>
				)}
				<span className="flex-1" />
				{pipeline?.url && (
					<CiTip tip={`Open run ${pipeline.runId} in the browser`}>
						<button
							aria-label={`Open the run of ${pipeline.name}`}
							className={link}
							onClick={() =>
								UiServiceClient.openUrl(StringRequest.create({ value: pipeline.url })).catch(console.error)
							}
							type="button">
							<span className="codicon codicon-link-external text-[11px]" />
						</button>
					</CiTip>
				)}
				{fix && <FixButton fix={fix} item={item} {...run} />}
			</div>
			{fix && !fix.actionId && fix.tooltip && <div className="text-description mt-0.5 pl-3.5">{fix.tooltip}</div>}
			{triage?.summary && <div className="text-description mt-0.5 pl-3.5">{triage.summary}</div>}
			{triage?.steps.map((step) => (
				<StepDetail key={`${step.job}›${step.step}`} step={step} />
			))}
		</div>
	)
}

interface CiItemDetailsProps extends RunProps {
	item: CiItem
	onAnalyze: () => void
	onRequeue: (evaluationId: string) => Promise<void>
	requeueing?: string
	showBuildPolicies?: boolean
}

/**
 * An item, pipeline by pipeline: what is wrong with each one and the single
 * fix that fits it, then Fix them all, which works through every problem at once.
 */
export const CiItemDetails = ({ item, onAnalyze, onRequeue, requeueing, showBuildPolicies, ...run }: CiItemDetailsProps) => {
	const policies = showBuildPolicies
		? (item.buildPolicies ?? [])
		: (item.expiredBuildPolicies ?? []).map((p) => ({
				...p,
				expired: true,
				status: item.buildPolicies?.find((b) => b.evaluationId === p.evaluationId)?.status ?? "unknown",
			}))
	const triage = item.triage
	const fixes = new Map(item.fixes.map((f) => [f.pipeline, f]))
	const conflict = fixes.get("")
	const fixAll = item.actions.find((a) => a.actionId === "fix-ci")
	const failing = item.fixes.length > 0
	const noSteps = !!triage && triage.pipelines.length > 0 && triage.pipelines.every((p) => p.steps.length === 0)
	const disabledReason = run.runningReason || fixAll?.disabledReason
	return (
		<div className="text-xs pl-5 pr-1 pb-1" data-testid="ci-item-details">
			{conflict && <PipelineRow fix={conflict} item={item} {...run} />}
			{showBuildPolicies && (
				<div className="py-2 text-description">
					{policies.length
						? "Choose the build validation to requeue against the PR's current preview merge."
						: "No build validation policies are available for this PR. Refresh the board after configuring one in Azure DevOps."}
				</div>
			)}
			{policies.map((policy) => (
				<div
					className="py-1.5 border-t border-border-panel flex items-center gap-2"
					data-testid="ci-expired-policy"
					key={policy.evaluationId}>
					<span className={policy.expired ? "codicon codicon-warning text-warning" : "codicon codicon-beaker"} />
					<span className="min-w-0 truncate" title={policy.name}>
						{policy.name}
					</span>
					<span className="rounded px-1 text-[10px] text-description">
						{policy.expired ? "Expired" : policy.status}
					</span>
					<span className="flex-1" />
					<Button
						disabled={
							!!requeueing || policy.status === "queued" || policy.status === "running" || item.state !== "open"
						}
						onClick={() => void onRequeue(policy.evaluationId)}
						size="sm"
						variant="secondary">
						{requeueing === policy.evaluationId ? "Requeueing…" : "Requeue pipeline"}
					</Button>
				</div>
			))}
			{item.pipelines.map((pipeline) => (
				<PipelineRow
					fix={fixes.get(pipeline.name)}
					item={item}
					key={pipeline.name}
					pipeline={pipeline}
					triage={triage?.pipelines.find((t) => t.name === pipeline.name)}
					{...run}
				/>
			))}
			{item.pipelines.length === 0 && !conflict && (
				<div className="text-description py-1">No pipeline has run on the head commit yet.</div>
			)}
			{failing && fixAll && (
				<div className="flex items-center gap-2 pt-1.5 border-t border-border-panel">
					<CiTip tip={disabledReason || fixAll.tooltip} wrap={!!disabledReason}>
						<Button
							data-testid="ci-fix-all"
							disabled={!!run.busy || !!disabledReason}
							onClick={() => void run.onRun(fixAll.actionId)}
							size="sm"
							variant={item.fixes.length > 1 ? "default" : "secondary"}>
							<span
								className={cn(
									"codicon",
									run.busy === runKey(fixAll.actionId)
										? "codicon-loading codicon-modifier-spin"
										: "codicon-sparkle",
								)}
							/>
							{fixAll.label}
						</Button>
					</CiTip>
					<span className="text-description min-w-0">
						{item.fixes.length > 1
							? "Works out each problem and applies the fix that fits it, one after the other."
							: "The single fix above is the safer choice for one problem."}
					</span>
				</div>
			)}
			{failing && !triage && (
				<div className="text-description pt-1.5">
					Not analysed yet.{" "}
					<button className={link} onClick={onAnalyze} type="button">
						Analyze the failures
					</button>
				</div>
			)}
			{triage && (
				<>
					{noSteps && triage.status !== "pending" && (
						<div className="text-description py-1">The step details are not loaded. Analyze again to read them.</div>
					)}
					{triage.error && <div className="text-warning py-1 break-words">{triage.error}</div>}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5 text-description">
						{triage.reportPath && (
							<CiTip
								tip={`The full report, with every error and log line read: ${triage.reportPath}. It is kept out of git.`}>
								<button
									className={link}
									data-testid="ci-open-report"
									onClick={() =>
										FileServiceClient.openFile(StringRequest.create({ value: triage.reportPath })).catch(
											console.error,
										)
									}
									type="button">
									<span className="codicon codicon-file-text text-[11px]" /> Open full report
								</button>
							</CiTip>
						)}
						<CiTip tip="Read the failed runs again and ask a free model for a new summary and severity.">
							<button className={link} disabled={triage.status === "pending"} onClick={onAnalyze} type="button">
								<span
									className={cn(
										"codicon text-[11px]",
										triage.status === "pending" ? "codicon-loading codicon-modifier-spin" : "codicon-sync",
									)}
								/>
								{triage.status === "pending" ? "Analyzing…" : "Analyze again"}
							</button>
						</CiTip>
						<span>
							{triage.status === "pending"
								? "A free model is reading the failures."
								: `Analysed ${timeAgo(triage.analyzedTs)} by ${triage.source === "model" ? "a free model" : "rules (the model was unavailable)"}.`}
						</span>
						{triage.stale && (
							<span className="text-warning">This analysis is for an older commit or set of runs.</span>
						)}
					</div>
				</>
			)}
		</div>
	)
}
