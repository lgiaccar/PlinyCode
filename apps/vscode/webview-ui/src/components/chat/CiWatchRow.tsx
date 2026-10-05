import { ciWatchReportBody } from "@shared/ciWatch"
import { MarkdownRow } from "./MarkdownRow"

/**
 * A report the CI watcher sent into the conversation. It is stored like a
 * message from the user, because it starts a turn, but the user did not type
 * it: it gets its own heading and none of the user bubble's edit controls.
 */
export function CiWatchRow({ text }: { text: string }) {
	return (
		<div>
			<div className="flex items-center gap-2.5 mb-3">
				<span className="codicon codicon-pulse text-foreground mb-[-1.5px]" />
				<span className="font-bold text-foreground">CI watcher</span>
			</div>
			<div className="pt-1">
				<MarkdownRow markdown={ciWatchReportBody(text)} />
			</div>
		</div>
	)
}
