import { StringRequest } from "@shared/proto/cline/common"
import { AssociatePipelineRequest, type PipelineLaunchInfo } from "@shared/proto/cline/pipeline"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { PipelineServiceClient, UiServiceClient } from "@/services/grpc-client"
import { fieldClass, pipelineError } from "./PipelineLaunchForm"

const statusLabels: Record<string, string> = {
	queued: "Queued",
	in_progress: "Running",
	completed: "Completed",
	dispatching: "Queueing",
	accepted: "Accepted",
	rejected: "Rejected",
	unknown: "Unconfirmed",
	awaiting_identification: "Awaiting run ID",
}

export function PipelineRunRow({ launch }: { launch: PipelineLaunchInfo }) {
	const [runId, setRunId] = useState("")
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState("")
	const associate = async () => {
		setBusy(true)
		setError("")
		try {
			await PipelineServiceClient.associatePipelineRun(
				AssociatePipelineRequest.create({ id: launch.id, runId: Number(runId) }),
			)
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			setBusy(false)
		}
	}
	const failed = ["failure", "cancelled", "partial"].includes(launch.result) || launch.status === "rejected"
	return (
		<li
			className="flex flex-col gap-1.5 py-3 border-b border-panel-border last:border-b-0 min-w-0"
			data-testid="pipeline-launch">
			<div className="flex items-start gap-2 min-w-0">
				<span
					aria-hidden="true"
					className={`codicon mt-0.5 ${launch.result === "success" ? "codicon-pass text-success" : failed ? "codicon-error text-error" : launch.status === "in_progress" ? "codicon-loading codicon-modifier-spin text-warning" : "codicon-clock text-description"}`}
				/>
				<div className="flex-1 min-w-0">
					<div className="text-sm font-medium wrap-anywhere">{launch.pipelineName}</div>
					<div className="text-xs text-description wrap-break-word">
						{launch.ref}
						{launch.runId ? ` / #${launch.runId}` : ""}
					</div>
				</div>
				<Button
					aria-label={`Open ${launch.pipelineName} run`}
					className="h-7 w-7 shrink-0"
					onClick={() =>
						UiServiceClient.openUrl(StringRequest.create({ value: launch.url })).catch((failure) =>
							setError(pipelineError(failure)),
						)
					}
					size="icon"
					title="Open in provider"
					variant="ghost">
					<span aria-hidden="true" className="codicon codicon-link-external" />
				</Button>
			</div>
			<div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs">
				<span>{launch.result || statusLabels[launch.status] || launch.status}</span>
				<time dateTime={new Date(launch.created).toISOString()}>{new Date(launch.created).toLocaleString()}</time>
			</div>
			<div className="text-xs text-description wrap-anywhere" title={launch.repoRoot}>
				{launch.provider === "github" ? "GitHub" : "Azure DevOps"} /{" "}
				{launch.repoRoot.split(/[\\/]/).filter(Boolean).at(-1)}
			</div>
			{launch.updated > 0 && (
				<div className="text-xs text-description">Updated {new Date(launch.updated).toLocaleTimeString()}</div>
			)}
			{launch.needsAssociation && (
				<div className="flex items-center gap-2 min-w-0">
					<input
						aria-label={`Run ID for ${launch.pipelineName}`}
						className={`${fieldClass} flex-1`}
						disabled={busy}
						min={1}
						onChange={(event) => setRunId(event.target.value)}
						placeholder="Provider run ID"
						step={1}
						type="number"
						value={runId}
					/>
					<Button
						disabled={busy || !Number.isSafeInteger(Number(runId)) || Number(runId) <= 0}
						onClick={associate}
						size="sm"
						title="Link this launch to the provider run">
						Link run
					</Button>
				</div>
			)}
			{(error || launch.error) && (
				<div className="text-xs text-error wrap-break-word" role="alert">
					{error || launch.error}
				</div>
			)}
		</li>
	)
}
