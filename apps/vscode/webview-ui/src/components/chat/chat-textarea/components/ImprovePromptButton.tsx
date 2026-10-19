import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { LoaderCircleIcon, WandSparklesIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

interface ImprovePromptButtonProps {
	disabled: boolean
	pending: boolean
	onClick: () => void
}

/** The wand under the prompt box: rewrites the draft for grammar and clarity with a small free model. */
export function ImprovePromptButton({ disabled, pending, onClick }: ImprovePromptButtonProps) {
	return (
		<Tooltip>
			<TooltipContent className="text-xs px-2 max-w-64" side="top">
				{pending
					? "Improving the prompt..."
					: "Improve prompt: fix grammar and make it clearer, with a small free model. You can undo it."}
			</TooltipContent>
			<TooltipTrigger asChild>
				<VSCodeButton
					appearance="icon"
					aria-label="Improve prompt"
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
