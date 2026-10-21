import type { ClineCompactionInfo, ClineMessage } from "@shared/ExtensionMessage"
import { FoldVerticalIcon, LoaderCircleIcon } from "lucide-react"
import { useState } from "react"
import { cn } from "@/lib/utils"
import { compactionPayload, parseSayPayload } from "./chat-payloads"
import { UndisplayableMessageRow } from "./UndisplayableMessageRow"

/** Mirrors the CLI's formatTokenCount (apps/cli/src/tui/utils/compaction-status.ts). */
function formatTokenCount(count: number): string {
	if (count < 1_000) {
		return `${count}`
	}
	if (count < 1_000_000) {
		return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`
	}
	return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
}

/** Mirrors the CLI's formatCompactionDividerLabel wording for product consistency. */
function formatCompactionLabel(info: ClineCompactionInfo): string {
	const overflow = info.mode === "overflow"
	if (info.status === "started") {
		return info.mode === "manual"
			? "Compacting context"
			: overflow
				? "Context too large: compacting"
				: "Auto compacting context"
	}
	if (info.status === "failed") {
		return "Compaction failed"
	}
	if (info.status === "cancelled") {
		return "Compaction cancelled"
	}
	if (info.status === "skipped") {
		return "Compaction skipped"
	}
	const parts: string[] = [
		info.mode === "manual"
			? "Context compacted (manual)"
			: overflow
				? "Context compacted (the model rejected it as too large)"
				: "Context compacted",
	]
	if (typeof info.tokensBefore === "number" && typeof info.tokensAfter === "number") {
		parts.push(`${formatTokenCount(info.tokensBefore)} → ${formatTokenCount(info.tokensAfter)} tokens`)
	}
	if (typeof info.messagesBefore === "number" && typeof info.messagesAfter === "number") {
		parts.push(`${info.messagesBefore} → ${info.messagesAfter} messages`)
	}
	return parts.join(" · ")
}

/**
 * Divider row for context compaction progress and results — the webview
 * counterpart of the CLI's CompactionDividerRow. Shows a spinner while a
 * compaction is running; the same message (same ts) is updated in place to
 * its terminal state when it finishes. A completed agentic compaction can be
 * opened to show the summary the model continues from. The row is the chat's
 * record of the compaction only: it is never sent to the model.
 */
const CompactionRow = ({ message }: { message: ClineMessage }) => {
	const [open, setOpen] = useState(false)
	if (!message.text) {
		// Virtuoso cannot handle zero-height items; render a spacer instead of null.
		return <div aria-hidden className="h-px" />
	}
	const parsed = parseSayPayload(message, compactionPayload)
	if (!parsed.ok) {
		return <UndisplayableMessageRow error={parsed.error} message={message} />
	}
	const info = parsed.value

	const inProgress = info.status === "started"
	const isFailed = info.status === "failed"
	const isMuted = info.status === "skipped" || info.status === "cancelled"
	const summary = info.status === "completed" ? info.summary : undefined

	return (
		<div className="py-1.5">
			<div
				className={cn("flex items-center gap-2 text-description", {
					"text-error": isFailed,
					"opacity-70": isMuted,
				})}>
				{inProgress ? (
					<LoaderCircleIcon className="size-2 shrink-0 animate-spin" />
				) : (
					<FoldVerticalIcon className="size-2 shrink-0" />
				)}
				<span className="min-w-0">
					{formatCompactionLabel(info)}
					{inProgress ? "…" : ""}
				</span>
				{summary && (
					<button
						aria-expanded={open}
						className="p-0 bg-transparent border-0 cursor-pointer text-xs text-(--vscode-textLink-foreground)"
						onClick={() => setOpen((value) => !value)}
						type="button">
						{open ? "Hide summary" : "Show summary"}
					</button>
				)}
				<div className="flex-1 min-w-4 border-t border-description/30" />
			</div>
			{summary && open && (
				<div className="mt-1.5 ml-4 p-2 rounded-xs border border-editor-group-border text-xs text-description whitespace-pre-wrap break-words max-h-80 overflow-y-auto">
					<div className="mb-1 font-medium text-foreground/80">The summary the model continues from</div>
					{summary}
				</div>
			)}
		</div>
	)
}

export default CompactionRow
