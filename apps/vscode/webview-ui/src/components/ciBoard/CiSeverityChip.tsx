import type { CiTriage } from "@shared/proto/cline/ci_board"
import { cn } from "@/lib/utils"
import { CiTip } from "./CiTip"
import { SEVERITY_META } from "./ciBoardUtils"

/** How bad an item's failures are, from the board's triage; a spinner while it runs. */
export const CiSeverityChip = ({ triage }: { triage?: CiTriage }) => {
	if (!triage) return null
	if (triage.status === "pending" && !triage.summary) {
		return (
			<CiTip tip="A free model is reading the failed runs to say what failed and how serious it is.">
				<span
					className="codicon codicon-loading codicon-modifier-spin text-description flex-shrink-0"
					data-testid="severity-pending"
				/>
			</CiTip>
		)
	}
	const meta = SEVERITY_META[triage.severity] ?? SEVERITY_META.medium
	return (
		<CiTip tip={`${meta.tip}${triage.stale ? " This analysis is for an older state of the pull request." : ""}`}>
			<span
				className={cn(
					"inline-flex items-center gap-0.5 rounded px-1 text-[10px] font-semibold uppercase tracking-wide flex-shrink-0 border",
					triage.stale && "opacity-60",
				)}
				data-severity={triage.severity}
				data-testid="severity-chip"
				style={{ color: meta.color, borderColor: meta.color }}>
				<span className={cn("codicon text-[11px]", meta.icon)} />
				{meta.label}
			</span>
		</CiTip>
	)
}
