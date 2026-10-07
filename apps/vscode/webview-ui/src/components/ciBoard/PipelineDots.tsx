import type { CiPipeline } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { cn } from "@/lib/utils"
import { UiServiceClient } from "@/services/grpc-client"
import { DOT_COLORS, pipelineTitle } from "./ciBoardUtils"

/** One colored dot per pipeline; clicking a dot opens its run. */
export const PipelineDots = ({ pipelines }: { pipelines: CiPipeline[] }) => {
	if (pipelines.length === 0) {
		return <span className="text-xs text-description">no pipelines yet</span>
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-1" data-testid="pipeline-dots">
			{pipelines.map((p) => (
				<button
					aria-label={pipelineTitle(p)}
					className={cn(
						"inline-block size-2.5 rounded-full border-0 p-0 cursor-pointer disabled:cursor-default",
						p.color === "yellow" && "animate-pulse",
						p.color === "grey" && "opacity-50",
					)}
					data-color={p.color}
					disabled={!p.url}
					key={p.name}
					onClick={() => p.url && UiServiceClient.openUrl(StringRequest.create({ value: p.url })).catch(console.error)}
					style={{ background: DOT_COLORS[p.color] ?? DOT_COLORS.grey }}
					title={pipelineTitle(p)}
					type="button"
				/>
			))}
		</span>
	)
}
