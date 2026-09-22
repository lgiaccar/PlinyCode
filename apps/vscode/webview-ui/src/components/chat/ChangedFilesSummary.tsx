import type { ChangedFileSummary, LatestChangesSummary } from "@shared/proto/cline/checkpoints"
import { CheckpointChangesSummaryRequest, OpenFileDiffRequest } from "@shared/proto/cline/checkpoints"
import { EmptyRequest } from "@shared/proto/cline/common"
import { ChevronDownIcon, ChevronRightIcon, GitCompareIcon } from "lucide-react"
import { memo, useCallback, useEffect, useState } from "react"
import { CheckpointsServiceClient } from "@/services/grpc-client"
import SuccessButton from "../common/SuccessButton"
import { formatChangedFilesSummaryLine } from "./formatChangedFilesSummary"

const STATUS_CODICON: Record<string, string> = {
	added: "codicon-diff-added",
	modified: "codicon-diff-modified",
	deleted: "codicon-diff-removed",
}

function splitRelativePath(relativePath: string): { directory: string; fileName: string } {
	const normalized = relativePath.replace(/\\/g, "/")
	const slash = normalized.lastIndexOf("/")
	if (slash === -1) {
		return { directory: "", fileName: normalized }
	}
	return {
		directory: `${normalized.slice(0, slash + 1)}`,
		fileName: normalized.slice(slash + 1),
	}
}

export interface ChangedFilesSummaryProps {
	/** Reserved for future user_feedback boundaries; defaults to latest checkpoint from the host. */
	checkpointRunCount?: number
}

export const ChangedFilesSummary = memo(({ checkpointRunCount: checkpointRunCountProp }: ChangedFilesSummaryProps) => {
	const [summary, setSummary] = useState<LatestChangesSummary | undefined>(undefined)
	const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading")
	const [expanded, setExpanded] = useState(false)
	const [openAllPending, setOpenAllPending] = useState(false)

	useEffect(() => {
		setLoadState("loading")
		setSummary(undefined)
		let cancelled = false
		CheckpointsServiceClient.checkpointLatestChangesSummary(CheckpointChangesSummaryRequest.create({}))
			.then((result) => {
				if (!cancelled) {
					setSummary(result)
					setLoadState("ready")
				}
			})
			.catch((err) => {
				console.error("Failed to load latest PlinyCode changes summary:", err)
				if (!cancelled) {
					setLoadState("error")
				}
			})
		return () => {
			cancelled = true
		}
	}, [])

	const effectiveRunCount = checkpointRunCountProp ?? summary?.checkpointRunCount ?? 0
	const files = summary?.files ?? []
	const hasChanges = loadState === "ready" && files.length > 0

	const openFileDiff = useCallback(
		(file: ChangedFileSummary) => {
			CheckpointsServiceClient.checkpointOpenFileDiff(
				OpenFileDiffRequest.create({
					filePath: file.filePath,
					checkpointRunCount: effectiveRunCount,
				}),
			).catch((err) => console.error("Failed to open file diff:", err))
		},
		[effectiveRunCount],
	)

	if (loadState === "loading") {
		return null
	}

	if (loadState === "error") {
		return (
			<p className="text-xs text-description px-1">
				Could not load file changes. Check that this workspace is a git repository and checkpoints are enabled.
			</p>
		)
	}

	if (!hasChanges || !summary) {
		return null
	}

	const summaryLine = formatChangedFilesSummaryLine({
		fileCount: files.length,
		totalAdded: summary.totalAdded,
		totalRemoved: summary.totalRemoved,
	})

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex items-stretch gap-1.5">
				<button
					aria-expanded={expanded}
					className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm border border-success/30 bg-success/5 px-2 py-1.5 text-left text-xs text-success/90 hover:bg-success/10"
					onClick={() => setExpanded((value) => !value)}
					type="button">
					{expanded ? (
						<ChevronDownIcon className="size-3 shrink-0" />
					) : (
						<ChevronRightIcon className="size-3 shrink-0" />
					)}
					<span className="truncate">{summaryLine}</span>
				</button>
				<SuccessButton
					aria-label="Open all PlinyCode changes"
					disabled={openAllPending}
					onClick={() => {
						setOpenAllPending(true)
						CheckpointsServiceClient.checkpointViewLatestChanges(EmptyRequest.create({}))
							.catch((err) => console.error("Failed to view latest changes:", err))
							.finally(() => setOpenAllPending(false))
					}}
					style={{ cursor: openAllPending ? "wait" : "pointer" }}>
					<GitCompareIcon className="size-3" />
					<span className="sr-only">Open all</span>
					<span className="hidden sm:inline">Open all</span>
				</SuccessButton>
			</div>
			{expanded && (
				<ul className="max-h-48 overflow-y-auto rounded-sm border border-success/20 bg-background/40 text-xs">
					{files.map((file) => {
						const { directory, fileName } = splitRelativePath(file.relativePath)
						const codicon = STATUS_CODICON[file.status] ?? "codicon-file"
						return (
							<li key={file.filePath}>
								<button
									className="flex w-full items-center gap-1.5 px-2 py-1 hover:bg-list-hoverBackground text-left"
									onClick={() => openFileDiff(file)}
									type="button">
									<span aria-hidden className={`codicon ${codicon} shrink-0 text-description`} />
									<span className="min-w-0 flex-1 truncate font-mono">
										{directory ? <span className="text-description">{directory}</span> : null}
										<span>{fileName}</span>
									</span>
									<span className="shrink-0 tabular-nums text-description">
										+{file.addedLines} -{file.removedLines}
									</span>
								</button>
							</li>
						)
					})}
				</ul>
			)}
		</div>
	)
})

ChangedFilesSummary.displayName = "ChangedFilesSummary"
