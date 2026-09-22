import { CheckpointChangesSummaryRequest } from "@shared/proto/cline/checkpoints"
import { EditMessageAndRegenerateRequest } from "@shared/proto/cline/task"
import type React from "react"
import { useMemo, useState } from "react"
import Thumbnails from "@/components/common/Thumbnails"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { CheckpointsServiceClient, TaskServiceClient } from "@/services/grpc-client"
import { highlightText } from "./task-header/Highlights"

interface UserMessageProps {
	text?: string
	files?: string[]
	images?: string[]
	messageTs?: number
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	canRestoreWorkspace?: boolean
	restoreWorkspaceDisabledReason?: string
}

const UserMessage: React.FC<UserMessageProps> = ({
	text,
	images,
	files,
	messageTs,
	canRestoreWorkspace = true,
	restoreWorkspaceDisabledReason = "PlinyCode cannot revert files for this message.",
}) => {
	const [isEditing, setIsEditing] = useState(false)
	const [editedText, setEditedText] = useState(text ?? "")
	const [editedImages, setEditedImages] = useState(images ?? [])
	const [editedFiles, setEditedFiles] = useState(files ?? [])
	const [savingMode, setSavingMode] = useState<"chat" | "workspace" | undefined>()
	const [errorMessage, setErrorMessage] = useState<string | undefined>()
	const [workspaceRevertPreview, setWorkspaceRevertPreview] = useState<
		{ fileCount: number; totalAdded: number; totalRemoved: number } | undefined
	>()
	const [loadingRevertPreview, setLoadingRevertPreview] = useState(false)
	const highlightedText = useMemo(() => highlightText(text), [text])

	const resetEditState = () => {
		setWorkspaceRevertPreview(undefined)
		setLoadingRevertPreview(false)
		setErrorMessage(undefined)
	}

	const startEditing = () => {
		setEditedText(text ?? "")
		setEditedImages(images ?? [])
		setEditedFiles(files ?? [])
		resetEditState()
		setIsEditing(true)
	}

	const cancelEditing = () => {
		if (savingMode) {
			return
		}
		resetEditState()
		setIsEditing(false)
	}

	const handleEditingKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			cancelEditing()
			return
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		void handleSave(false)
	}

	const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === "Escape") {
			event.preventDefault()
			event.stopPropagation()
			cancelEditing()
			return
		}
		if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) {
			return
		}
		event.preventDefault()
		event.stopPropagation()
		void handleSave(false)
	}

	const handleSave = async (restoreWorkspace: boolean) => {
		if (!messageTs || savingMode) {
			return
		}
		setSavingMode(restoreWorkspace ? "workspace" : "chat")
		setErrorMessage(undefined)
		try {
			await TaskServiceClient.editMessageAndRegenerate(
				EditMessageAndRegenerateRequest.create({
					messageTs,
					text: editedText,
					images: editedImages,
					files: editedFiles,
					restoreWorkspace,
				}),
			)
			resetEditState()
			setIsEditing(false)
			setSavingMode(undefined)
		} catch (error) {
			console.error("Failed to edit and regenerate message:", error)
			setErrorMessage(error instanceof Error ? error.message : "PlinyCode could not restart from this message")
			setSavingMode(undefined)
		}
	}

	const requestWorkspaceRevert = async () => {
		if (!messageTs || savingMode || !canRestoreWorkspace) {
			return
		}
		if (workspaceRevertPreview) {
			return
		}
		setLoadingRevertPreview(true)
		setErrorMessage(undefined)
		try {
			const summary = await CheckpointsServiceClient.checkpointLatestChangesSummary(
				CheckpointChangesSummaryRequest.create({ messageTs }),
			)
			setWorkspaceRevertPreview({
				fileCount: summary.files.length,
				totalAdded: summary.totalAdded,
				totalRemoved: summary.totalRemoved,
			})
		} catch (error) {
			console.error("Failed to load checkpoint revert preview:", error)
			setErrorMessage(error instanceof Error ? error.message : "PlinyCode could not load files to revert")
		} finally {
			setLoadingRevertPreview(false)
		}
	}

	return (
		<div
			className={`group relative p-2.5 my-1 text-badge-foreground rounded-xs ${
				messageTs && !isEditing ? "cursor-pointer pr-8" : ""
			}`}
			onClick={messageTs && !isEditing ? startEditing : undefined}
			onKeyDown={
				messageTs && !isEditing
					? (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault()
								startEditing()
							}
						}
					: undefined
			}
			role={messageTs && !isEditing ? "button" : undefined}
			style={{
				backgroundColor: "var(--vscode-badge-background)",
				whiteSpace: "pre-line",
				wordWrap: "break-word",
			}}
			tabIndex={messageTs && !isEditing ? 0 : undefined}
			title={messageTs && !isEditing ? "Edit and restart from here" : undefined}>
			{messageTs && !isEditing && (
				<Tooltip>
					<TooltipContent side="left">Edit and restart from here</TooltipContent>
					<TooltipTrigger asChild>
						<button
							aria-label="Edit and restart from this message"
							className="absolute right-1.5 top-1.5 opacity-0 group-hover:opacity-80 hover:opacity-100 bg-transparent border-0 text-badge-foreground cursor-pointer p-1"
							onClick={(event) => {
								event.stopPropagation()
								startEditing()
							}}
							type="button">
							<i className="codicon codicon-edit" />
						</button>
					</TooltipTrigger>
				</Tooltip>
			)}
			{isEditing ? (
				<div className="flex flex-col gap-2" onKeyDown={handleEditingKeyDown}>
					<textarea
						className="w-full box-border rounded-xs border border-vscode-input-border bg-vscode-input-background text-vscode-input-foreground p-2 text-sm resize-vertical"
						disabled={!!savingMode}
						onChange={(event) => setEditedText(event.target.value)}
						onKeyDown={handleTextareaKeyDown}
						rows={Math.max(3, editedText.split("\n").length)}
						value={editedText}
					/>
					{(editedImages.length > 0 || editedFiles.length > 0) && (
						<Thumbnails
							files={editedFiles}
							images={editedImages}
							setFiles={setEditedFiles}
							setImages={setEditedImages}
						/>
					)}
					{workspaceRevertPreview && (
						<div className="text-xs rounded-xs border border-vscode-input-border bg-vscode-input-background p-2">
							Revert{" "}
							<strong>
								{workspaceRevertPreview.fileCount} file{workspaceRevertPreview.fileCount === 1 ? "" : "s"}
							</strong>{" "}
							(+{workspaceRevertPreview.totalAdded}/-{workspaceRevertPreview.totalRemoved} lines) to the checkpoint
							from this message?
							<div className="flex gap-2 mt-2 justify-end">
								<button
									className="px-2 py-1 text-xs rounded-xs border border-vscode-button-border bg-transparent cursor-pointer"
									disabled={!!savingMode}
									onClick={() => setWorkspaceRevertPreview(undefined)}
									type="button">
									Cancel
								</button>
								<button
									className="px-2 py-1 text-xs rounded-xs border-0 bg-vscode-button-background text-vscode-button-foreground cursor-pointer disabled:opacity-60"
									disabled={!!savingMode}
									onClick={() => void handleSave(true)}
									type="button">
									{savingMode === "workspace" ? "Reverting..." : "Revert files and restart"}
								</button>
							</div>
						</div>
					)}
					{errorMessage && <div className="text-xs text-(--vscode-errorForeground)">{errorMessage}</div>}
					<div className="flex items-center justify-between gap-1.5">
						<button
							className="shrink-0 whitespace-nowrap px-1 py-1 rounded-xs border-0 bg-transparent text-badge-foreground/80 hover:text-badge-foreground cursor-pointer text-xs"
							disabled={!!savingMode}
							onClick={cancelEditing}
							type="button">
							Cancel
						</button>
						<div className="flex items-center gap-1.5">
							<Tooltip>
								<TooltipContent side="top">
									Rewind the chat from here; keep your current code edits
								</TooltipContent>
								<TooltipTrigger asChild>
									<span className="inline-flex shrink-0">
										<button
											className="whitespace-nowrap px-2 py-1 rounded-xs border border-vscode-button-border bg-transparent text-badge-foreground cursor-pointer disabled:opacity-60 text-xs"
											disabled={!!savingMode}
											onClick={() => void handleSave(false)}
											type="button">
											{savingMode === "chat" ? "Restarting..." : "Restart from here"}
										</button>
									</span>
								</TooltipTrigger>
							</Tooltip>
							<Tooltip>
								<TooltipContent side="top">
									{canRestoreWorkspace
										? "Rewind the chat and restore workspace files to the checkpoint from this message"
										: restoreWorkspaceDisabledReason}
								</TooltipContent>
								<TooltipTrigger asChild>
									<span className="inline-flex shrink-0">
										<button
											aria-disabled={!canRestoreWorkspace}
											className="whitespace-nowrap px-2 py-1 rounded-xs border border-vscode-button-border bg-transparent text-badge-foreground cursor-pointer disabled:opacity-60 text-xs"
											disabled={!!savingMode || !canRestoreWorkspace || loadingRevertPreview}
											onClick={() => void requestWorkspaceRevert()}
											type="button">
											{loadingRevertPreview
												? "Loading..."
												: savingMode === "workspace"
													? "Reverting..."
													: "Restart and revert files"}
										</button>
									</span>
								</TooltipTrigger>
							</Tooltip>
						</div>
					</div>
				</div>
			) : (
				<span className="ph-no-capture text-sm" style={{ display: "block" }}>
					{highlightedText}
				</span>
			)}
			{!isEditing && ((images && images.length > 0) || (files && files.length > 0)) && (
				<Thumbnails files={files ?? []} images={images ?? []} style={{ marginTop: "8px" }} />
			)}
		</div>
	)
}

export default UserMessage
