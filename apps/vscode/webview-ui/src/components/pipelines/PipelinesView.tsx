import { EmptyRequest } from "@shared/proto/cline/common"
import type { PipelineHistory } from "@shared/proto/cline/pipeline"
import { useEffect, useState } from "react"
import ViewHeader from "@/components/common/ViewHeader"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { PipelineServiceClient } from "@/services/grpc-client"
import { PipelineLaunchForm, pipelineError } from "./PipelineLaunchForm"
import { PipelineRunRow } from "./PipelineRunRow"

export default function PipelinesView({ onDone }: { onDone: () => void }) {
	const { environment } = useExtensionState()
	const [history, setHistory] = useState<PipelineHistory>()
	const [error, setError] = useState("")
	const [refreshing, setRefreshing] = useState(false)
	const [connection, setConnection] = useState(0)
	useEffect(
		() =>
			PipelineServiceClient.subscribeToPipelineRuns(EmptyRequest.create({}), {
				onResponse: (response) => {
					setHistory(response)
					setError("")
				},
				onError: (failure) => setError(pipelineError(failure)),
				onComplete: () => {},
			}),
		[connection],
	)
	const refresh = async () => {
		setRefreshing(true)
		setError("")
		setConnection((current) => current + 1)
		try {
			await PipelineServiceClient.refreshPipelineRuns(EmptyRequest.create({}))
		} catch (failure) {
			setError(pipelineError(failure))
		} finally {
			setRefreshing(false)
		}
	}
	return (
		<div className="fixed inset-0 flex flex-col min-w-0">
			<ViewHeader environment={environment} onDone={onDone} title="Pipelines" />
			<div className="flex-1 overflow-auto px-5 py-3 min-w-0">
				{history?.unavailable ? (
					<div className="text-sm text-description break-words">{history.unavailable}</div>
				) : (
					<PipelineLaunchForm />
				)}
				<div className="flex justify-between items-center gap-2 mt-4 mb-1">
					<h2 className="text-sm font-medium m-0">Run History</h2>
					<Button
						aria-label="Refresh run history"
						className="h-7 w-7 shrink-0"
						disabled={refreshing}
						onClick={refresh}
						size="icon"
						title="Refresh run history"
						variant="ghost">
						<span
							aria-hidden="true"
							className={`codicon codicon-refresh ${refreshing ? "codicon-modifier-spin" : ""}`}
						/>
					</Button>
				</div>
				{error && (
					<div className="text-sm text-error break-words" role="alert">
						{error}
					</div>
				)}
				{!history ? (
					<div className="text-sm text-description">Loading...</div>
				) : history.launches.length === 0 ? (
					<div className="text-sm text-description">No launches yet.</div>
				) : (
					<ul className="list-none m-0 p-0">
						{history.launches.map((launch) => (
							<PipelineRunRow key={launch.id} launch={launch} />
						))}
					</ul>
				)}
			</div>
		</div>
	)
}
