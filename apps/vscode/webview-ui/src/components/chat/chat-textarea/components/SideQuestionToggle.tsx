import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

interface SideQuestionToggleProps {
	checked: boolean
	/** False while a side question cannot be sent: no conversation yet, or the agent is busy or waiting for an answer. */
	available: boolean
	onChange: (checked: boolean) => void
}

/**
 * The "Side question" checkbox under the prompt box. A message sent with it
 * ticked is asked off the record: it is answered without changing any file,
 * and later requests leave the question and its answer out of the context.
 * The box clears itself after each send.
 */
export function SideQuestionToggle({ checked, available, onChange }: SideQuestionToggleProps) {
	return (
		<Tooltip>
			<TooltipContent className="text-xs px-2 max-w-64" side="top">
				{available
					? "Ask without adding to the context: the question and its answer stay in the chat but are left out of later messages to the model. The agent can read and search, but not change files."
					: "Side questions can be asked once the conversation has started and the agent is not working or waiting for an answer."}
			</TooltipContent>
			<TooltipTrigger asChild>
				<label
					className={cn(
						"flex items-center gap-1 mr-2 text-xs select-none whitespace-nowrap",
						available ? "cursor-pointer text-input-foreground" : "cursor-not-allowed opacity-50",
					)}
					data-testid="side-question-toggle">
					<input
						checked={checked && available}
						className="m-0 cursor-[inherit]"
						disabled={!available}
						onChange={(event) => onChange(event.target.checked)}
						type="checkbox"
					/>
					Side question
				</label>
			</TooltipTrigger>
		</Tooltip>
	)
}
