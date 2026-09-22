import { ExportTaskRequest } from "@shared/proto/cline/task"
import { DownloadIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"

/**
 * Saves the conversation as a readable `.md` file. The extension side shows the
 * save dialog, so a cancelled dialog simply writes nothing.
 */
const ExportMarkdownButton: React.FC<{
	taskId?: string
	className?: string
}> = ({ taskId, className }) => {
	const handleExport = () => {
		if (!taskId) {
			return
		}

		TaskServiceClient.exportTaskToMarkdown(ExportTaskRequest.create({ taskId })).catch((err) =>
			console.error("Failed to export task as markdown:", err),
		)
	}

	return (
		<Tooltip>
			<TooltipContent>Export conversation as Markdown</TooltipContent>
			<TooltipTrigger className={cn("flex items-center", className)}>
				<Button
					aria-label="Export conversation as Markdown"
					onClick={(e) => {
						e.preventDefault()
						e.stopPropagation()
						handleExport()
					}}
					size="icon"
					variant="icon">
					<DownloadIcon />
				</Button>
			</TooltipTrigger>
		</Tooltip>
	)
}

ExportMarkdownButton.displayName = "ExportMarkdownButton"
export default ExportMarkdownButton
