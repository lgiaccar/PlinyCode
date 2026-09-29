import { type WorkspaceRef, workspaceRefLabel, workspaceRefsEqual } from "@shared/workspaceRef"
import { FileJsonIcon, FolderIcon, FolderOpenIcon, LayersIcon } from "lucide-react"
import { useMemo } from "react"
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import type { WorkspacesState } from "./useWorkspaces"

const WORKSPACE_SELECT_CURRENT = "__current__"
const WORKSPACE_SELECT_ALL = "__all__"
const PICK_FOLDER = "__pick_folder__"
const PICK_FILE = "__pick_file__"

/** What the select stands on: the window's workspace, every workspace, or one by path. */
export type WorkspaceSelection = { kind: "current" } | { kind: "all" } | { kind: "workspace"; workspace: WorkspaceRef }

interface WorkspaceSelectProps {
	workspaces: WorkspacesState
	value: WorkspaceSelection
	onChange: (selection: WorkspaceSelection) => void
	/** Offer an "All workspaces" entry (history filtering). */
	allowAll?: boolean
	/** Offer the native folder / .code-workspace pickers (starting a conversation elsewhere). */
	allowPick?: boolean
	className?: string
	"aria-label"?: string
}

/**
 * Dropdown over the window's workspace and the recently used ones, with an
 * optional "All workspaces" entry and optional entries that open the native
 * folder or `.code-workspace` picker.
 */
export function WorkspaceSelect({
	workspaces,
	value,
	onChange,
	allowAll = false,
	allowPick = false,
	className,
	"aria-label": ariaLabel,
}: WorkspaceSelectProps) {
	const { platform } = useExtensionState()
	const { current, recent, pick } = workspaces

	// A workspace chosen through the picker may not be in the recent list yet.
	const entries = useMemo(() => {
		const list = [...recent]
		if (
			value.kind === "workspace" &&
			!workspaceRefsEqual(value.workspace, current) &&
			!list.some((entry) => workspaceRefsEqual(entry, value.workspace))
		) {
			list.unshift(value.workspace)
		}
		return list
	}, [recent, current, value])

	const selectValue =
		value.kind === "current"
			? WORKSPACE_SELECT_CURRENT
			: value.kind === "all"
				? WORKSPACE_SELECT_ALL
				: workspaceRefsEqual(value.workspace, current)
					? WORKSPACE_SELECT_CURRENT
					: value.workspace.path

	const selectedLabel =
		value.kind === "all"
			? "All workspaces"
			: value.kind === "current" || workspaceRefsEqual(value.workspace, current)
				? current
					? workspaceRefLabel(current, platform)
					: "No workspace"
				: workspaceRefLabel(value.workspace, platform)

	const selectedTitle =
		value.kind === "all"
			? "Conversations from every workspace"
			: value.kind === "current"
				? (current?.path ?? "No folder is open")
				: value.workspace.path

	const handleChange = async (next: string) => {
		if (next === WORKSPACE_SELECT_CURRENT) {
			onChange({ kind: "current" })
		} else if (next === WORKSPACE_SELECT_ALL) {
			onChange({ kind: "all" })
		} else if (next === PICK_FOLDER || next === PICK_FILE) {
			const picked = await pick(next === PICK_FOLDER ? "folder" : "workspaceFile")
			if (picked) {
				onChange(workspaceRefsEqual(picked, current) ? { kind: "current" } : { kind: "workspace", workspace: picked })
			}
		} else {
			const workspace = entries.find((entry) => entry.path === next)
			if (workspace) {
				onChange({ kind: "workspace", workspace })
			}
		}
	}

	return (
		<Select onValueChange={(next) => void handleChange(next)} value={selectValue}>
			<SelectTrigger
				aria-label={ariaLabel ?? "Workspace"}
				className={cn(
					"h-6 max-w-full gap-1 border-0 px-1.5 py-0 text-xs text-description hover:text-foreground",
					className,
				)}
				data-size="sm"
				data-testid="workspace-select"
				title={selectedTitle}>
				{value.kind === "all" ? (
					<LayersIcon className="shrink-0 opacity-70" size={11} />
				) : (
					<FolderIcon className="shrink-0 opacity-70" size={11} />
				)}
				<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{selectedLabel}</span>
			</SelectTrigger>
			<SelectContent align="start" className="max-w-[320px]" position="popper">
				{current && (
					<SelectItem title={current.path} value={WORKSPACE_SELECT_CURRENT}>
						<span className="flex items-center gap-2">
							<FolderIcon className="shrink-0 opacity-70" size={12} />
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								{workspaceRefLabel(current, platform)}
							</span>
							<span className="text-description">(this window)</span>
						</span>
					</SelectItem>
				)}
				{allowAll && (
					<SelectItem value={WORKSPACE_SELECT_ALL}>
						<span className="flex items-center gap-2">
							<LayersIcon className="shrink-0 opacity-70" size={12} />
							All workspaces
						</span>
					</SelectItem>
				)}
				{entries.length > 0 && (current || allowAll) && <SelectSeparator />}
				{entries.map((entry) => (
					<SelectItem key={entry.path} title={entry.path} value={entry.path}>
						<span className="flex items-center gap-2">
							{entry.kind === "workspaceFile" ? (
								<FileJsonIcon className="shrink-0 opacity-70" size={12} />
							) : (
								<FolderIcon className="shrink-0 opacity-70" size={12} />
							)}
							<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
								{workspaceRefLabel(entry, platform)}
							</span>
						</span>
					</SelectItem>
				))}
				{allowPick && (
					<>
						{(entries.length > 0 || current || allowAll) && <SelectSeparator />}
						<SelectItem value={PICK_FOLDER}>
							<span className="flex items-center gap-2">
								<FolderOpenIcon className="shrink-0 opacity-70" size={12} />
								Choose folder…
							</span>
						</SelectItem>
						<SelectItem value={PICK_FILE}>
							<span className="flex items-center gap-2">
								<FileJsonIcon className="shrink-0 opacity-70" size={12} />
								Choose .code-workspace file…
							</span>
						</SelectItem>
					</>
				)}
			</SelectContent>
		</Select>
	)
}
