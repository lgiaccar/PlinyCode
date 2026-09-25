import * as fs from "node:fs/promises"
import * as path from "node:path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageRequest, ShowMessageType, ShowSaveDialogRequest } from "@/shared/proto/host/window"
import { Logger } from "@/shared/services/Logger"

/**
 * `plinycode-conversation-<yyyyMMdd-HHmm>.md`, in local time so the name lines
 * up with when the user sees the task in History.
 */
export function defaultMarkdownExportFilename(ts: number): string {
	const date = new Date(ts)
	const pad = (value: number) => String(value).padStart(2, "0")
	const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
	return `plinycode-conversation-${stamp}.md`
}

/**
 * Ask the user where to save the rendered conversation, write it there, and
 * offer to open it.
 *
 * @returns the written path, or undefined when the dialog was cancelled — in
 * which case nothing is written and no notification is shown.
 */
export async function saveMarkdownExport(
	markdown: string,
	options: { defaultDirectory: string; defaultFilename: string },
): Promise<string | undefined> {
	const { selectedPath } = await HostProvider.window.showSaveDialog(
		ShowSaveDialogRequest.create({
			options: {
				defaultPath: path.join(options.defaultDirectory, options.defaultFilename),
				filters: { Markdown: { extensions: ["md"] } },
			},
		}),
	)
	if (!selectedPath) {
		return undefined
	}

	await fs.writeFile(selectedPath, markdown, "utf8")
	Logger.log(`[EXPORT] Wrote conversation markdown: ${selectedPath}`)

	const choice = (
		await HostProvider.window.showMessage(
			ShowMessageRequest.create({
				type: ShowMessageType.INFORMATION,
				message: `Conversation exported to ${selectedPath}`,
				options: { items: ["Open file"] },
			}),
		)
	).selectedOption
	if (choice === "Open file") {
		await HostProvider.window.showTextDocument({ path: selectedPath, options: { preview: false } })
	}

	return selectedPath
}
