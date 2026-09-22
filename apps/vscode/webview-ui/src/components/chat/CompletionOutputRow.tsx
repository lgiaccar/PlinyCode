import { memo } from "react"
import { CopyButton } from "../common/CopyButton"
import { ChangedFilesSummary } from "./ChangedFilesSummary"
import type { QuoteButtonState } from "./ChatRow"
import { CheckpointsEnablePrompt } from "./CheckpointsEnablePrompt"
import { MarkdownRow } from "./MarkdownRow"
import QuoteButton from "./QuoteButton"

interface CompletionOutputRowProps {
	text: string
	quoteButtonState: QuoteButtonState
	handleQuoteClick: () => void
	/**
	 * Shows the changed-files summary inside the card (multi-file diff since the
	 * checkpoint taken when the user's last message started the run). Only on the
	 * latest, finalized completion row.
	 */
	showViewChanges?: boolean
	/** When checkpoints are disabled, offer an inline toggle on the completion card. */
	showCheckpointsEnablePrompt?: boolean
}

/**
 * Quiet visual cue that the agent's turn ended on this response (act mode):
 * a green-tinted container with a small, muted "Completed" label and a copy
 * button. Deliberately less prominent than the legacy bold "Task Completed"
 * header, since the response might be a question or an interim summary
 * rather than a definitive task completion.
 */
export const CompletionOutputRow = memo(
	({ text, quoteButtonState, handleQuoteClick, showViewChanges, showCheckpointsEnablePrompt }: CompletionOutputRowProps) => {
		return (
			<div className="rounded-sm border border-success/20 overflow-visible bg-success/10">
				<div className="flex items-center justify-between gap-2 pl-2 pr-1 pt-1 -mb-1.5">
					<span className="text-xs font-medium uppercase tracking-wider text-success/70">Completed</span>
					<CopyButton ariaLabel="Copy response" className="text-success/70" textToCopy={text} />
				</div>
				<div className="completion-output-content relative p-2 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0 rounded-sm">
					<MarkdownRow markdown={text} />
					{quoteButtonState.visible && (
						<QuoteButton left={quoteButtonState.left} onClick={handleQuoteClick} top={quoteButtonState.top} />
					)}
				</div>
				{(showViewChanges || showCheckpointsEnablePrompt) && (
					<div className="px-2 pb-2 flex flex-col gap-2">
						{showCheckpointsEnablePrompt && <CheckpointsEnablePrompt />}
						{showViewChanges && <ChangedFilesSummary />}
					</div>
				)}
			</div>
		)
	},
)

CompletionOutputRow.displayName = "CompletionOutputRow"
