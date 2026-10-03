import { StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { FileTextIcon } from "lucide-react"
import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { FileServiceClient } from "@/services/grpc-client"

interface PlanCompletionOutputProps {
	text: string
	/** Workspace-relative root plan file (plans/<slug>/PLAN.md) written this plan. */
	rootPlanFile?: string
	/** Shown only together with rootPlanFile, while the plan can still be executed. */
	onExecutePlan?: () => void
}

/**
 * Quiet visual cue that the agent's plan-mode turn ended on this response:
 * a container tinted with the yellow plan accent (matching the plan/act
 * toggle and the CLI's plan-mode color) with a small, muted "Plan" label
 * and a copy button. Deliberately less prominent than the legacy bold
 * "Plan Created" header, since the response might be a question rather
 * than a finished plan.
 *
 * When the plan was written to markdown files, a footer links the root plan
 * file (so the user can open and edit it) and offers "Execute plan", which
 * switches to act mode and asks the agent to run that file.
 */
const PlanCompletionOutputRow = memo(({ text, rootPlanFile, onExecutePlan }: PlanCompletionOutputProps) => {
	return (
		<div className="rounded-sm border border-warning/20 overflow-visible bg-warning/10">
			<div className="flex items-center justify-between gap-2 pl-2 pr-1 pt-1 -mb-1.5">
				<span className="text-xs font-medium uppercase tracking-wider text-warning/70">Plan</span>
				<CopyButton ariaLabel="Copy plan response" className="text-warning/70" textToCopy={text} />
			</div>
			<div className="plan-completion-content p-2 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0">
				<div className="wrap-anywhere [&_hr]:opacity-20">
					<MarkdownBlock markdown={text} />
				</div>
			</div>
			{rootPlanFile && onExecutePlan && (
				<div className="flex items-center justify-between gap-2 border-t border-warning/20 px-2 py-1.5">
					<button
						className="flex min-w-0 items-center gap-1 bg-transparent border-0 p-0 cursor-pointer text-xs text-link hover:underline"
						onClick={() =>
							FileServiceClient.openFileRelativePath(StringRequest.create({ value: rootPlanFile })).catch((err) =>
								console.error("Failed to open plan file:", err),
							)
						}
						title={`Open ${rootPlanFile} to review or edit the plan`}
						type="button">
						<FileTextIcon className="size-3 shrink-0" />
						<span className="truncate">{rootPlanFile}</span>
					</button>
					<VSCodeButton className="shrink-0" onClick={onExecutePlan}>
						Execute plan
					</VSCodeButton>
				</div>
			)}
		</div>
	)
})

PlanCompletionOutputRow.displayName = "PlanCompletionOutputRow"

export default PlanCompletionOutputRow
