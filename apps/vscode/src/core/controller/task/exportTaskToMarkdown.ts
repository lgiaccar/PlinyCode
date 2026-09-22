import { ExportTaskRequest, ExportTaskResult } from "@shared/proto/cline/task"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Renders a task's conversation as Markdown and writes it to a path the user
 * picks in a save dialog.
 * @param controller The controller instance
 * @param request Task id plus the include_tool_output / include_reasoning flags
 * @returns The written path, or an empty path when the dialog was cancelled
 */
export async function exportTaskToMarkdown(controller: Controller, request: ExportTaskRequest): Promise<ExportTaskResult> {
	try {
		const path = await controller.exportTaskToMarkdown(request.taskId, {
			includeToolOutput: request.includeToolOutput,
			includeReasoning: request.includeReasoning,
		})
		return ExportTaskResult.create({ path: path ?? "" })
	} catch (error) {
		// Log the error but allow it to propagate for proper gRPC error handling
		Logger.error(`Error exporting task ${request.taskId} to markdown:`, error)
		throw error
	}
}
