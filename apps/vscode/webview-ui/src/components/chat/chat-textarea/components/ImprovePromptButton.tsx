import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { LoaderCircleIcon, WandSparklesIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface ImprovePromptButtonProps {
	disabled: boolean
	pending: boolean
	label?: string
	generating?: boolean
	onClick: () => void
}

/** The prompt wand improves a draft or generates follow-up choices for an empty composer. */
export function ImprovePromptButton({
	disabled,
	pending,
	onClick,
	label = "Improve prompt",
	generating = false,
}: ImprovePromptButtonProps) {
	return (
		<Tooltip>
			<TooltipContent className="text-xs px-2 max-w-64" side="top">
				{pending
					? generating
						? "Generating…"
						: "Improving the prompt..."
					: generating
						? `${label}: generate fresh suggestions from the conversation.`
						: "Improve prompt: fix grammar and make it clearer, with a small free model. You can undo it."}
			</TooltipContent>
			<TooltipTrigger asChild>
				<VSCodeButton
					appearance="icon"
					aria-label={pending && generating ? "Generating…" : label}
					className="p-0 m-0 mr-1 flex items-center"
					data-testid="improve-prompt-button"
					disabled={disabled || pending}
					onClick={() => {
						if (!disabled && !pending) {
							onClick()
						}
					}}>
					{pending ? <LoaderCircleIcon className="animate-spin" size={13} /> : <WandSparklesIcon size={13} />}
				</VSCodeButton>
			</TooltipTrigger>
		</Tooltip>
	)
}
