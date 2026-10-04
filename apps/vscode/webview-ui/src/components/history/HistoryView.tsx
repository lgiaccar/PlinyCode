import { EmptyRequest, StringArrayRequest } from "@shared/proto/cline/common"
import {
	GetTaskHistoryRequest,
	RenameTaskRequest,
	TaskFavoriteRequest,
	type TaskItem,
	TaskPinRequest,
} from "@shared/proto/cline/task"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import Fuse from "fuse.js"
import { ArrowUpDownIcon, CalendarIcon, StarIcon } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { GroupedVirtuoso } from "react-virtuoso"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { formatSize } from "@/utils/format"
import ViewHeader from "../common/ViewHeader"
import { useWorkspaces } from "../workspace/useWorkspaces"
import { WorkspaceSelect, type WorkspaceSelection } from "../workspace/WorkspaceSelect"
import HistoryViewItem from "./HistoryViewItem"
import { type CustomDateRange, DATE_FILTERS, type DateFilter, dateFilterRange, groupHistoryTasks } from "./historyFilters"

type HistoryViewProps = {
	onDone: () => void
}

type SortOption = "newest" | "oldest" | "mostExpensive" | "mostTokens" | "mostRelevant"

const SORT_OPTIONS: Record<SortOption, string> = {
	newest: "Newest",
	oldest: "Oldest",
	mostExpensive: "Most Expensive",
	mostTokens: "Most Tokens",
	mostRelevant: "Most Relevant",
}

const DATE_INPUT_CLASS = "h-6 rounded-[3px] border border-editor-group-border px-1 text-xs focus:outline-none"
const DATE_INPUT_STYLE: React.CSSProperties = {
	backgroundColor: "var(--vscode-input-background, var(--vscode-sideBar-background))",
	color: "var(--vscode-input-foreground, var(--vscode-foreground))",
}

const HISTORY_PAGE_SIZE = 50

const HistoryView = ({ onDone }: HistoryViewProps) => {
	const extensionStateContext = useExtensionState()
	const { taskHistory, onRelinquishControl, environment } = extensionStateContext
	const [searchQuery, setSearchQuery] = useState("")
	const [sortOption, setSortOption] = useState<SortOption>("newest")
	const [lastNonRelevantSort, setLastNonRelevantSort] = useState<SortOption | null>("newest")
	const [deleteAllDisabled, setDeleteAllDisabled] = useState(false)
	const [selectedItems, setSelectedItems] = useState<string[]>([])
	const [showFavoritesOnly, setShowFavoritesOnly] = useState(false)
	const [dateFilter, setDateFilter] = useState<DateFilter>("any")
	const [customDateRange, setCustomDateRange] = useState<CustomDateRange>({ from: "", to: "" })
	// Conversations are bound to workspaces; the window's own is shown by default.
	const [workspaceFilter, setWorkspaceFilter] = useState<WorkspaceSelection>({ kind: "current" })
	const workspaces = useWorkspaces()

	// Keep track of pending favorite toggle operations
	const [pendingFavoriteToggles, setPendingFavoriteToggles] = useState<Record<string, boolean>>({})

	// Load filtered task history with gRPC
	const [tasks, setTasks] = useState<TaskItem[]>([])
	const [hasMoreTasks, setHasMoreTasks] = useState(false)
	const [nextHistoryOffset, setNextHistoryOffset] = useState(0)
	const [isLoadingHistory, setIsLoadingHistory] = useState(false)
	const isLoadingHistoryRef = useRef(false)
	const historyRequestIdRef = useRef(0)
	const hasRequestedTotalTasksSizeRef = useRef(false)

	// Load and refresh task history
	const loadTaskHistory = useCallback(
		async (offset = 0) => {
			if (offset > 0 && isLoadingHistoryRef.current) {
				return
			}

			const requestId = ++historyRequestIdRef.current
			isLoadingHistoryRef.current = true
			setIsLoadingHistory(true)
			try {
				const startedAt = performance.now()
				const { fromTs, toTs } = dateFilterRange(dateFilter, customDateRange)
				const response = await TaskServiceClient.getTaskHistory(
					GetTaskHistoryRequest.create({
						favoritesOnly: showFavoritesOnly,
						fromTs,
						toTs,
						searchQuery: searchQuery || undefined,
						sortBy: sortOption,
						currentWorkspaceOnly: workspaceFilter.kind === "current",
						workspacePath: workspaceFilter.kind === "workspace" ? workspaceFilter.workspace.path : "",
						limit: HISTORY_PAGE_SIZE,
						offset,
					}),
				)
				console.log(
					`[HistoryPerf] getTaskHistory offset=${offset} tasks=${response.tasks?.length ?? 0} hasMore=${response.hasMore} took ${Math.round(performance.now() - startedAt)}ms`,
				)
				if (requestId !== historyRequestIdRef.current) {
					return
				}
				const pageTasks = response.tasks || []
				setTasks((currentTasks) => {
					if (offset === 0) {
						return pageTasks
					}

					const mergedTasks = new Map(currentTasks.map((task) => [task.id, task]))
					for (const task of pageTasks) {
						mergedTasks.set(task.id, task)
					}
					return Array.from(mergedTasks.values())
				})
				setHasMoreTasks(response.hasMore)
				setNextHistoryOffset(offset + HISTORY_PAGE_SIZE)
			} catch (error) {
				console.error("Error loading task history:", error)
			} finally {
				if (requestId === historyRequestIdRef.current) {
					isLoadingHistoryRef.current = false
					setIsLoadingHistory(false)
				}
			}
		},
		[showFavoritesOnly, workspaceFilter, searchQuery, sortOption, dateFilter, customDateRange],
	)

	const loadMoreTaskHistory = useCallback(() => {
		if (!hasMoreTasks || isLoadingHistory) {
			return
		}
		loadTaskHistory(nextHistoryOffset)
	}, [hasMoreTasks, isLoadingHistory, loadTaskHistory, nextHistoryOffset])

	// Load when filters change
	useEffect(() => {
		setTasks([])
		setHasMoreTasks(false)
		setNextHistoryOffset(0)
		loadTaskHistory(0)
	}, [loadTaskHistory])

	// Other PlinyCode windows share the same conversations: when the extension
	// notices a change to the set (a conversation added, renamed, favorited,
	// pinned or deleted elsewhere) it pushes new state, and the list reloads. Keyed on
	// membership and titles rather than the array itself, which changes on
	// every state post (usage totals tick while a task streams).
	const taskHistorySignature = useMemo(
		() =>
			taskHistory.map((item) => `${item.id}:${item.task}:${item.isFavorited ? 1 : 0}:${item.isPinned ? 1 : 0}`).join("\n"),
		[taskHistory],
	)
	const lastTaskHistorySignatureRef = useRef(taskHistorySignature)
	useEffect(() => {
		if (lastTaskHistorySignatureRef.current === taskHistorySignature) {
			return
		}
		lastTaskHistorySignatureRef.current = taskHistorySignature
		loadTaskHistory(0)
	}, [taskHistorySignature, loadTaskHistory])

	const toggleFavorite = useCallback(
		async (taskId: string, currentValue: boolean) => {
			const nextValue = !currentValue

			// Optimistic UI update
			setPendingFavoriteToggles((prev) => ({ ...prev, [taskId]: nextValue }))

			try {
				await TaskServiceClient.toggleTaskFavorite(
					TaskFavoriteRequest.create({
						taskId,
						isFavorited: nextValue,
					}),
				)

				setTasks((currentTasks) =>
					currentTasks.map((task) => (task.id === taskId ? { ...task, isFavorited: nextValue } : task)),
				)

				// Refresh if either filter is active to ensure proper combined filtering
				if (showFavoritesOnly || workspaceFilter.kind !== "all") {
					await loadTaskHistory(0)
				}
			} catch (err) {
				console.error(`[FAVORITE_TOGGLE_UI] Error for task ${taskId}:`, err)
				// Revert optimistic update
				setPendingFavoriteToggles((prev) => {
					const updated = { ...prev }
					delete updated[taskId]
					return updated
				})
			} finally {
				// Clean up pending state after 1 second
				setTimeout(() => {
					setPendingFavoriteToggles((prev) => {
						const updated = { ...prev }
						delete updated[taskId]
						return updated
					})
				}, 1000)
			}
		},
		[showFavoritesOnly, workspaceFilter, loadTaskHistory],
	)

	const togglePin = useCallback(
		async (taskId: string, currentValue: boolean) => {
			const nextValue = !currentValue
			try {
				await TaskServiceClient.toggleTaskPin(TaskPinRequest.create({ taskId, isPinned: nextValue }))
				// Pinned conversations lead the list, so the order comes from the extension.
				await loadTaskHistory(0)
			} catch (err) {
				console.error(`Failed to ${nextValue ? "pin" : "unpin"} task ${taskId}:`, err)
			}
		},
		[loadTaskHistory],
	)

	const renameTask = useCallback((taskId: string, title: string) => {
		setTasks((currentTasks) => currentTasks.map((task) => (task.id === taskId ? { ...task, task: title } : task)))
		TaskServiceClient.renameTask(RenameTaskRequest.create({ taskId, title })).catch((err) => {
			console.error(`Failed to rename task ${taskId}:`, err)
		})
	}, [])

	// Use the onRelinquishControl hook instead of message event
	useEffect(() => {
		return onRelinquishControl(() => {
			setDeleteAllDisabled(false)
		})
	}, [onRelinquishControl])

	const { totalTasksSize, setTotalTasksSize } = extensionStateContext

	const fetchTotalTasksSize = useCallback(async () => {
		try {
			const startedAt = performance.now()
			const response = await TaskServiceClient.getTotalTasksSize(EmptyRequest.create({}))
			console.log(`[HistoryPerf] getTotalTasksSize took ${Math.round(performance.now() - startedAt)}ms`)
			if (response && typeof response.value === "number") {
				setTotalTasksSize?.(response.value || 0)
			}
		} catch (error) {
			console.error("Error getting total tasks size:", error)
		}
	}, [setTotalTasksSize])

	// Defer the expensive recursive task/checkpoint size scan until after the first
	// history page loads, so it does not compete with the initial history request.
	useEffect(() => {
		if (hasRequestedTotalTasksSizeRef.current || isLoadingHistory || nextHistoryOffset === 0 || totalTasksSize !== null) {
			return
		}

		hasRequestedTotalTasksSizeRef.current = true
		const timeout = window.setTimeout(() => {
			void fetchTotalTasksSize()
		}, 750)
		return () => window.clearTimeout(timeout)
	}, [fetchTotalTasksSize, isLoadingHistory, nextHistoryOffset, totalTasksSize])

	useEffect(() => {
		if (searchQuery && sortOption !== "mostRelevant" && !lastNonRelevantSort) {
			setLastNonRelevantSort(sortOption)
			setSortOption("mostRelevant")
		} else if (!searchQuery && sortOption === "mostRelevant" && lastNonRelevantSort) {
			setSortOption(lastNonRelevantSort)
			setLastNonRelevantSort(null)
		}
	}, [searchQuery, sortOption, lastNonRelevantSort])

	const handleHistorySelect = useCallback((itemId: string, checked: boolean) => {
		setSelectedItems((prev) => {
			if (checked) {
				return [...prev, itemId]
			}
			return prev.filter((id) => id !== itemId)
		})
	}, [])

	const handleDeleteHistoryItem = useCallback(
		(id: string) => {
			TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: [id] }))
				.then(async () => {
					await loadTaskHistory(0)
					await fetchTotalTasksSize()
				})
				.catch((error) => console.error("Error deleting task:", error))
		},
		[fetchTotalTasksSize, loadTaskHistory],
	)

	const handleDeleteSelectedHistoryItems = useCallback(
		(ids: string[]) => {
			if (ids.length > 0) {
				TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: ids }))
					.then(async () => {
						await loadTaskHistory(0)
						setSelectedItems([])
						await fetchTotalTasksSize()
					})
					.catch((error) => console.error("Error deleting tasks:", error))
			}
		},
		[fetchTotalTasksSize, loadTaskHistory],
	)

	const handleDeleteAllHistory = useCallback(() => {
		setDeleteAllDisabled(true)
		TaskServiceClient.deleteAllTaskHistory(EmptyRequest.create({}))
			.then(async () => {
				await loadTaskHistory(0)
				setSelectedItems([])
				await fetchTotalTasksSize()
			})
			.catch((error) => console.error("Error deleting task history:", error))
			.finally(() => setDeleteAllDisabled(false))
	}, [fetchTotalTasksSize, loadTaskHistory])

	const fuse = useMemo(() => {
		return new Fuse(tasks, {
			keys: ["task", "workspaceRoot"],
			threshold: 0.6,
			shouldSort: true,
			isCaseSensitive: false,
			// Match anywhere in the task text. With location-based scoring, a
			// match more than ~60 characters into the title scores above the
			// threshold and the task silently vanishes from search results
			// (e.g. searching "aqueducts" in "Write a detailed 800-word essay
			// about the history of the Roman aqueducts...").
			ignoreLocation: true,
			includeMatches: true,
			minMatchCharLength: 1,
		})
	}, [tasks])

	// The extension filters, sorts and pages the list, pinned conversations
	// first. Only the relevance ranking of a search happens here.
	const taskHistorySearchResults = useMemo(() => {
		if (!searchQuery || sortOption !== "mostRelevant") {
			return tasks
		}
		const ranked = fuse.search(searchQuery).map(({ item }) => item)
		const rankedIds = new Set(ranked.map((task) => task.id))
		return [...ranked, ...tasks.filter((task) => !rankedIds.has(task.id))]
	}, [tasks, searchQuery, fuse, sortOption])

	// Sections: "Pinned", then "Today" and "Older" for the date-based sorts.
	const { groupedTasks, groupCounts, groupLabels } = useMemo(() => {
		const grouped = groupHistoryTasks(taskHistorySearchResults, {
			groupByDay: sortOption === "newest" || sortOption === "oldest",
		})
		return { groupedTasks: grouped.tasks, groupCounts: grouped.groupCounts, groupLabels: grouped.groupLabels }
	}, [taskHistorySearchResults, sortOption])

	const hasActiveFilters = showFavoritesOnly || dateFilter !== "any" || searchQuery !== ""
	const clearFilters = useCallback(() => {
		setShowFavoritesOnly(false)
		setDateFilter("any")
		setCustomDateRange({ from: "", to: "" })
		setSearchQuery("")
	}, [])

	// Calculate total size of selected items
	const selectedItemsSize = useMemo(() => {
		if (selectedItems.length === 0) {
			return 0
		}

		return tasks.filter((item) => selectedItems.includes(item.id)).reduce((total, item) => total + (item.size || 0), 0)
	}, [selectedItems, tasks])

	const handleBatchHistorySelect = useCallback(
		(selectAll: boolean) => {
			if (selectAll) {
				setSelectedItems(taskHistorySearchResults.map((item) => item.id))
			} else {
				setSelectedItems([])
			}
		},
		[taskHistorySearchResults],
	)

	return (
		<div className="fixed overflow-hidden inset-0 flex flex-col w-full">
			{/* HEADER */}
			<ViewHeader environment={environment} onDone={onDone} title="History" />

			{/* FILTERS */}
			<div className="flex flex-col gap-3 px-3">
				{/* REPLACE VSCODE RADIO GROUP */}
				<div className="flex justify-between items-center">
					{/* SEARCH BOX */}
					<VSCodeTextField
						className="w-full"
						onInput={(e) => {
							const newValue = (e.target as HTMLInputElement)?.value
							setSearchQuery(newValue)
							if (newValue && !searchQuery && sortOption !== "mostRelevant") {
								setLastNonRelevantSort(sortOption)
								setSortOption("mostRelevant")
							}
						}}
						placeholder="Search history..."
						value={searchQuery}>
						<div className="codicon codicon-search opacity-80 mt-0.5 !text-sm" slot="start" />
						{searchQuery && (
							<div
								aria-label="Clear search"
								className="input-icon-button codicon codicon-close flex justify-center items-center h-full"
								onClick={() => setSearchQuery("")}
								slot="end"
							/>
						)}
					</VSCodeTextField>
					<Select
						onValueChange={(value) => {
							if (value === "mostRelevant" && !searchQuery) {
								// Don't allow selecting mostRelevant without a search query
								return
							}
							setSortOption(value as SortOption)
							if (value !== "mostRelevant") {
								setLastNonRelevantSort(value as SortOption)
							}
						}}
						value={sortOption}>
						<SelectTrigger aria-label="Sort history" className="border-0 cursor-pointer" showIcon={false}>
							<ArrowUpDownIcon className="!size-2 text-foreground" />
						</SelectTrigger>
						<SelectContent position="popper">
							{Object.entries(SORT_OPTIONS).map(([key, label]) => (
								<SelectItem
									className={sortOption === key ? "bg-button-background/30" : ""}
									disabled={key === "mostRelevant" && !searchQuery}
									key={key}
									value={key}>
									{label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				{/* FAVORITES AND DATE FILTERS */}
				<div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-description">
					<button
						aria-label="Show only favorites"
						aria-pressed={showFavoritesOnly}
						className={cn(
							"flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs cursor-pointer bg-transparent",
							showFavoritesOnly
								? "border-button-background text-foreground"
								: "border-editor-group-border text-description hover:text-foreground",
						)}
						onClick={() => setShowFavoritesOnly((current) => !current)}
						type="button">
						<StarIcon
							className={cn("size-3", { "text-button-background fill-button-background": showFavoritesOnly })}
						/>
						Favorites
					</button>
					<div className="flex items-center gap-1">
						<span className="shrink-0">Date</span>
						<Select onValueChange={(value) => setDateFilter(value as DateFilter)} value={dateFilter}>
							<SelectTrigger
								aria-label="Filter history by date"
								className="h-6 gap-1 border-0 px-1.5 py-0 text-xs text-description hover:text-foreground"
								data-size="sm">
								<CalendarIcon className="shrink-0 opacity-70" size={11} />
								<span className="whitespace-nowrap">{DATE_FILTERS[dateFilter]}</span>
							</SelectTrigger>
							<SelectContent align="start" position="popper">
								{Object.entries(DATE_FILTERS).map(([key, label]) => (
									<SelectItem key={key} value={key}>
										{label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					{hasActiveFilters && (
						<button
							className="ml-auto bg-transparent border-0 p-0 text-xs text-link cursor-pointer hover:underline"
							onClick={clearFilters}
							type="button">
							Clear filters
						</button>
					)}
				</div>
				{dateFilter === "custom" && (
					<div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-xs text-description">
						<label className="flex items-center gap-1">
							From
							<input
								aria-label="Active from"
								className={DATE_INPUT_CLASS}
								max={customDateRange.to || undefined}
								onChange={(e) => setCustomDateRange((range) => ({ ...range, from: e.target.value }))}
								style={DATE_INPUT_STYLE}
								type="datetime-local"
								value={customDateRange.from}
							/>
						</label>
						<label className="flex items-center gap-1">
							To
							<input
								aria-label="Active until"
								className={DATE_INPUT_CLASS}
								min={customDateRange.from || undefined}
								onChange={(e) => setCustomDateRange((range) => ({ ...range, to: e.target.value }))}
								style={DATE_INPUT_STYLE}
								type="datetime-local"
								value={customDateRange.to}
							/>
						</label>
					</div>
				)}
				{/* WORKSPACE FILTER */}
				<div className="flex items-center gap-1 text-xs text-description">
					<span className="shrink-0">Workspace</span>
					<WorkspaceSelect
						allowAll
						aria-label="Filter history by workspace"
						className="min-w-0"
						onChange={setWorkspaceFilter}
						value={workspaceFilter}
						workspaces={workspaces}
					/>
				</div>
			</div>

			{/* HISTORY ITEMS */}
			<div className="flex-grow overflow-y-auto m-0 w-full py-2">
				<GroupedVirtuoso
					className="flex-grow overflow-y-scroll"
					components={{
						EmptyPlaceholder: () =>
							isLoadingHistory ? null : (
								<div className="px-4 py-6 text-center text-xs text-description">
									{hasActiveFilters ? "No conversations match these filters." : "No conversations here yet."}
								</div>
							),
						Footer: () =>
							hasMoreTasks ? (
								<div className="px-4 py-3 text-center text-xs text-description">
									{isLoadingHistory ? "Loading..." : ""}
								</div>
							) : null,
					}}
					endReached={loadMoreTaskHistory}
					groupContent={(index) => (
						<div className="px-4 py-2 text-xs font-bold uppercase tracking-wide sticky top-0 z-10 text-description bg-sidebar-background border-b-border-panel">
							{groupLabels[index]}
						</div>
					)}
					groupCounts={groupCounts}
					itemContent={(index) => {
						const item = groupedTasks[index]
						return (
							<HistoryViewItem
								handleDeleteHistoryItem={handleDeleteHistoryItem}
								handleHistorySelect={handleHistorySelect}
								index={index}
								item={item}
								pendingFavoriteToggles={pendingFavoriteToggles}
								renameTask={renameTask}
								selectedItems={selectedItems}
								toggleFavorite={toggleFavorite}
								togglePin={togglePin}
							/>
						)
					}}
				/>
			</div>

			{/* FOOTER */}
			<div className="p-2.5 border-t border-t-border-panel">
				<div className="flex gap-2.5 mb-2.5">
					<Button className="flex-1" onClick={() => handleBatchHistorySelect(true)} variant="secondary">
						Select All
					</Button>
					<Button className="flex-1" onClick={() => handleBatchHistorySelect(false)} variant="secondary">
						Select None
					</Button>
				</div>
				{selectedItems.length > 0 ? (
					<Button
						aria-label="Delete selected items"
						className="w-full"
						onClick={() => {
							handleDeleteSelectedHistoryItems(selectedItems)
						}}
						variant="danger">
						Delete {selectedItems.length > 1 ? selectedItems.length : ""} Selected
						{selectedItemsSize > 0 ? ` (${formatSize(selectedItemsSize)})` : ""}
					</Button>
				) : (
					<Button
						aria-label="Delete all history"
						className="w-full"
						disabled={deleteAllDisabled || (taskHistory.length === 0 && tasks.length === 0)}
						onClick={handleDeleteAllHistory}
						variant="danger">
						Delete All History{totalTasksSize !== null ? ` (${formatSize(totalTasksSize)})` : ""}
					</Button>
				)}
			</div>
		</div>
	)
}

export default memo(HistoryView)
