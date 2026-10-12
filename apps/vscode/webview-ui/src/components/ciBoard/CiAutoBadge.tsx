import type { CiAutoStatus } from "@shared/proto/cline/ci_board"
import { cn } from "@/lib/utils"
import { CiTip } from "./CiTip"
import { AUTO_META } from "./ciBoardUtils"

/** What auto-watch is doing about an item; hidden while it has nothing to do. */
export const CiAutoBadge = ({ auto }: { auto?: CiAutoStatus }) => {
	if (!auto || auto.status === "idle") return null
	const meta = AUTO_META[auto.status] ?? AUTO_META.idle
	const attempt = auto.status === "running" && auto.attempt ? ` ${auto.attempt}/${auto.maxAttempts}` : ""
	return (
		<CiTip tip={auto.message}>
			<span
				className={cn(
					"inline-flex items-center gap-1 rounded px-1 text-[10px] flex-shrink-0",
					meta.tone === "warning" && "bg-warning/15 text-warning",
					meta.tone === "info" && "bg-button-background/20 text-foreground",
					meta.tone === "muted" && "text-description",
				)}
				data-status={auto.status}
				data-testid="ci-auto-badge">
				<span className={cn("codicon text-[11px]", meta.icon)} />
				{meta.label}
				{attempt}
			</span>
		</CiTip>
	)
}
