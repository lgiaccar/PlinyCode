import { PencilIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const RenameTaskButton: React.FC<{
	onClick: () => void
	className?: string
}> = ({ onClick, className }) => (
	<Tooltip>
		<TooltipContent>Rename conversation</TooltipContent>
		<TooltipTrigger className={cn("flex items-center", className)}>
			<Button
				aria-label="Rename conversation"
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					onClick()
				}}
				size="icon"
				variant="icon">
				<PencilIcon />
			</Button>
		</TooltipTrigger>
	</Tooltip>
)

RenameTaskButton.displayName = "RenameTaskButton"
export default RenameTaskButton
