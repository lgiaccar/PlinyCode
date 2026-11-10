import type { CiItem } from "@shared/proto/cline/ci_board"
import { ciBoardMergeDisabledReason } from "./ciBoardFilters"
import { timeAgo } from "./ciBoardUtils"

export function CiItemStatus({ item, now }: { item: CiItem; now: number }) {
	const reason = ciBoardMergeDisabledReason(item)
	const checked = item.checkedTs === undefined ? undefined : new Date(item.checkedTs)
	return (
		<div className="pl-5 flex flex-col gap-1 text-xs" data-testid="ci-item-status">
			{item.prId > 0 && item.state === "open" && (
				<div className={reason ? "text-description" : "text-foreground"}>
					{reason ? `Merge blocked: ${reason}` : "CI ready · Reviews and repository protections still apply."}
				</div>
			)}
			<div className="flex flex-wrap gap-x-2 text-[11px] text-description">
				{item.headSha && (
					<span title={item.headSha}>
						Head <code>{item.headSha.slice(0, 8)}</code>
					</span>
				)}
				{checked ? (
					<time dateTime={checked.toISOString()} title={`Last successful CI detail fetch: ${checked.toLocaleString()}`}>
						CI checked {timeAgo(item.checkedTs as number, now)}
					</time>
				) : (
					<span>CI check time unavailable</span>
				)}
				{item.error && <span className="text-warning">Refresh failed; showing last known data</span>}
			</div>
		</div>
	)
}
