import type { CiFailedStep, CiItem, CiPipelineTriage } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { CATEGORY_META, DOT_COLORS, timeAgo } from "./ciBoardUtils"

const ERRORS_SHOWN = 3
const EXCERPT_LINES = 12

const link = "bg-transparent border-0 p-0 text-link cursor-pointer inline-flex items-center gap-1"

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

const PipelineDetail = ({ pipeline }: { pipeline: CiPipelineTriage }) => {
	const category = CATEGORY_META[pipeline.category] ?? CATEGORY_META.unknown
	return (
		<div className="py-1.5 border-t border-border-panel first:border-t-0" data-testid="ci-pipeline-detail">
			<div className="flex items-center gap-1.5 min-w-0">
				<span className="inline-block size-2 rounded-full flex-shrink-0" style={{ background: DOT_COLORS.red }} />
				<span className="font-medium truncate">{pipeline.name}</span>
				<CiTip tip={category.tip}>
					<span className="rounded px-1 text-[10px] border border-border-panel text-description flex-shrink-0">
						{category.label}
					</span>
				</CiTip>
				<span className="flex-1" />
				{pipeline.url && (
					<CiTip tip={`Open run ${pipeline.runId} in the browser`}>
						<button
							aria-label="Open run"
							className={link}
							onClick={() =>
								UiServiceClient.openUrl(StringRequest.create({ value: pipeline.url })).catch(console.error)
							}
							type="button">
							<span className="codicon codicon-link-external text-[11px]" />
						</button>
					</CiTip>
				)}
			</div>
			{pipeline.summary && <div className="text-description mt-0.5">{pipeline.summary}</div>}
			{pipeline.steps.map((step) => (
				<StepDetail key={`${step.job}›${step.step}`} step={step} />
			))}
		</div>
	)
}

/** An item's failures, pipeline by pipeline, as the board's triage read them. */
export const CiItemDetails = ({ item, onAnalyze }: { item: CiItem; onAnalyze: () => void }) => {
	const triage = item.triage
	if (!triage) {
		return (
			<div className="text-xs text-description pl-5 py-1" data-testid="ci-item-details">
				Not analysed yet.{" "}
				<button className={link} onClick={onAnalyze} type="button">
					Analyze the failures
				</button>
			</div>
		)
	}
	const noSteps = triage.pipelines.length > 0 && triage.pipelines.every((p) => p.steps.length === 0)
	return (
		<div className="text-xs pl-5 pr-1 pb-1" data-testid="ci-item-details">
			{triage.conflict && (
				<div className="py-1 text-description">
					<span className="codicon codicon-git-merge text-[11px]" /> Conflicts with{" "}
					{item.targetBranch || "the target branch"}.
				</div>
			)}
			{triage.pipelines.map((pipeline) => (
				<PipelineDetail key={pipeline.name} pipeline={pipeline} />
			))}
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
				{triage.stale && <span className="text-warning">This analysis is for an older commit or set of runs.</span>}
			</div>
		</div>
	)
}
