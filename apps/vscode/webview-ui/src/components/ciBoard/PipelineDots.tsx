import type { CiPipeline } from "@shared/proto/cline/ci_board"
import { StringRequest } from "@shared/proto/cline/common"
import { cn } from "@/lib/utils"
import { UiServiceClient } from "@/services/grpc-client"
import { CiTip } from "./CiTip"
import { DOT_COLORS, pipelineTitle } from "./ciBoardUtils"

/** One colored dot per pipeline; clicking a dot opens its run. */
export const PipelineDots = ({ pipelines }: { pipelines: CiPipeline[] }) => {
	if (pipelines.length === 0) {
		return (
			<CiTip tip="No pipeline has run on the pull request's head commit yet.">
				<span className="text-[11px] text-description flex-shrink-0">no pipelines yet</span>
			</CiTip>
		)
	}
	return (
		<span className="inline-flex flex-wrap items-center gap-1 flex-shrink-0" data-testid="pipeline-dots">
			{pipelines.map((p) => (
				<CiTip key={p.name} tip={`${pipelineTitle(p)}${p.url ? " · click to open the run" : ""}`} wrap={!p.url}>
					<button
						aria-label={pipelineTitle(p)}
						className={cn(
							"inline-block size-2.5 rounded-full border-0 p-0 cursor-pointer disabled:cursor-default",
							p.color === "yellow" && "motion-safe:animate-pulse ring-1 ring-offset-0",
							p.color === "grey" && "opacity-50",
						)}
						data-color={p.color}
						disabled={!p.url}
						onClick={() =>
							p.url && UiServiceClient.openUrl(StringRequest.create({ value: p.url })).catch(console.error)
						}
						style={{ background: DOT_COLORS[p.color] ?? DOT_COLORS.grey }}
						type="button"
					/>
				</CiTip>
			))}
		</span>
	)
}
