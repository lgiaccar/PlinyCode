import { StringRequest } from "@shared/proto/cline/common"
import { FileSearchRequest, FileSearchType } from "@shared/proto/cline/file"
import type React from "react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { FileServiceClient } from "@/services/grpc-client"
import { ContextMenuOptionType, getContextMenuOptionIndex, insertMention, type SearchResult } from "@/utils/context-mentions"

interface GitCommit {
	type: ContextMenuOptionType.Git
	value: string
	label: string
	description: string
}

// Set to "File" option by default
export const DEFAULT_CONTEXT_MENU_OPTION = getContextMenuOptionIndex(ContextMenuOptionType.File)

/**
 * The @-mention context menu: its open/selection/search state, the git-commit
 * and file-search data it shows, and the handler that applies a selection to
 * the textarea. `inputValue` is read by the mention-insertion callback, and
 * `setInputValue`/`textAreaRef` are used to write the result back into the
 * shared textarea state that lives in the parent component.
 */
export function useContextMenu(setInputValue: (value: string) => void, textAreaRef: React.RefObject<HTMLTextAreaElement | null>) {
	const [showContextMenu, setShowContextMenu] = useState(false)
	const [selectedMenuIndex, setSelectedMenuIndex] = useState(-1)
	const [selectedType, setSelectedType] = useState<ContextMenuOptionType | null>(null)
	const [searchQuery, setSearchQuery] = useState("")
	const [cursorPosition, setCursorPosition] = useState(0)
	const [justDeletedSpaceAfterMention, setJustDeletedSpaceAfterMention] = useState(false)
	const [intendedCursorPosition, setIntendedCursorPosition] = useState<number | null>(null)
	const contextMenuContainerRef = useRef<HTMLDivElement>(null)

	const [gitCommits, setGitCommits] = useState<GitCommit[]>([])
	const [fileSearchResults, setFileSearchResults] = useState<SearchResult[]>([])
	const [searchLoading, setSearchLoading] = useState(false)

	// Monotonic token; every searchFiles dispatch bumps it, and resolve
	// handlers drop their result when the token they captured at fire time
	// is no longer the latest. Prevents stale results from a cancelled or
	// superseded picker (e.g. "Add File" still in flight when user picks
	// "Add Folder") from clobbering fresh state.
	const latestSearchTokenRef = useRef(0)

	// Fetch git commits when Git is selected or when typing a hash
	useEffect(() => {
		if (selectedType === ContextMenuOptionType.Git || /^[a-f0-9]+$/i.test(searchQuery)) {
			FileServiceClient.searchCommits(StringRequest.create({ value: searchQuery || "" }))
				.then((response) => {
					if (response.commits) {
						const commits: GitCommit[] = response.commits.map(
							(commit: { hash: string; shortHash: string; subject: string; author: string; date: string }) => ({
								type: ContextMenuOptionType.Git,
								value: commit.hash,
								label: commit.subject,
								description: `${commit.shortHash} by ${commit.author} on ${commit.date}`,
							}),
						)
						setGitCommits(commits)
					}
				})
				.catch((error) => {
					console.error("Error searching commits:", error)
				})
		}
	}, [selectedType, searchQuery])

	const queryItems = useMemo(() => {
		return [
			{ type: ContextMenuOptionType.Problems, value: "problems" },
			{ type: ContextMenuOptionType.Terminal, value: "terminal" },
			...gitCommits,
		]
	}, [gitCommits])

	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			if (contextMenuContainerRef.current && !contextMenuContainerRef.current.contains(event.target as Node)) {
				setShowContextMenu(false)
			}
		}

		if (showContextMenu) {
			document.addEventListener("mousedown", handleClickOutside)
		}

		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [showContextMenu])

	useEffect(() => {
		if (!showContextMenu) {
			setSelectedType(null)
		}
	}, [showContextMenu])

	const handleMentionSelect = useCallback(
		(type: ContextMenuOptionType, value?: string) => {
			if (type === ContextMenuOptionType.NoResults) {
				return
			}

			if (
				type === ContextMenuOptionType.File ||
				type === ContextMenuOptionType.Folder ||
				type === ContextMenuOptionType.Git
			) {
				if (!value) {
					setSelectedType(type)
					setSearchQuery("")
					setSelectedMenuIndex(0)

					// Trigger search with the selected type
					if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
						setSearchLoading(true)

						// Map ContextMenuOptionType to FileSearchType enum
						let searchType: FileSearchType | undefined
						if (type === ContextMenuOptionType.File) {
							searchType = FileSearchType.FILE
						} else if (type === ContextMenuOptionType.Folder) {
							searchType = FileSearchType.FOLDER
						}

						const myToken = ++latestSearchTokenRef.current
						FileServiceClient.searchFiles(
							FileSearchRequest.create({
								query: "",
								mentionsRequestId: String(myToken),
								selectedType: searchType,
							}),
						)
							.then((results) => {
								if (myToken !== latestSearchTokenRef.current) {
									// Stale response — a newer search has been issued.
									return
								}
								setFileSearchResults((results.results || []) as SearchResult[])
								setSearchLoading(false)
							})
							.catch((error) => {
								if (myToken !== latestSearchTokenRef.current) {
									return
								}
								console.error("Error searching files:", error)
								setFileSearchResults([])
								setSearchLoading(false)
							})
					}
					return
				}
			}

			setShowContextMenu(false)
			setSelectedType(null)
			const queryLength = searchQuery.length
			setSearchQuery("")

			if (textAreaRef.current) {
				let insertValue = value || ""
				if (type === ContextMenuOptionType.URL) {
					insertValue = value || ""
				} else if (type === ContextMenuOptionType.File || type === ContextMenuOptionType.Folder) {
					insertValue = value || ""
				} else if (type === ContextMenuOptionType.Problems) {
					insertValue = "problems"
				} else if (type === ContextMenuOptionType.Terminal) {
					insertValue = "terminal"
				} else if (type === ContextMenuOptionType.Git) {
					insertValue = value || ""
				}

				const { newValue, mentionIndex } = insertMention(
					textAreaRef.current.value,
					cursorPosition,
					insertValue,
					queryLength,
				)

				setInputValue(newValue)
				const newCursorPosition = newValue.indexOf(" ", mentionIndex + insertValue.length) + 1
				setCursorPosition(newCursorPosition)
				setIntendedCursorPosition(newCursorPosition)
				// textAreaRef.current.focus()

				// scroll to cursor
				setTimeout(() => {
					if (textAreaRef.current) {
						textAreaRef.current.blur()
						textAreaRef.current.focus()
					}
				}, 0)
			}
		},
		[setInputValue, cursorPosition, searchQuery, textAreaRef],
	)

	const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

	// Marks the search as loading immediately, then debounces the actual
	// file/folder search request for `query` (plus an optional workspace hint
	// parsed out of an "@workspace:/query" mention), keyed to `selectedType`.
	// This is the input-change-driven search path (see the main component's
	// `handleInputChange`); it shares `fileSearchResults`/`searchLoading` and
	// the stale-response token with the context-menu-driven search above.
	const triggerFileSearch = useCallback(
		(query: string, workspaceHint?: string) => {
			setSearchLoading(true)

			if (searchTimeoutRef.current) {
				clearTimeout(searchTimeoutRef.current)
			}

			const searchType =
				selectedType === ContextMenuOptionType.File
					? FileSearchType.FILE
					: selectedType === ContextMenuOptionType.Folder
						? FileSearchType.FOLDER
						: undefined

			// Set a timeout to debounce the search requests
			searchTimeoutRef.current = setTimeout(() => {
				const myToken = ++latestSearchTokenRef.current
				FileServiceClient.searchFiles(
					FileSearchRequest.create({
						query,
						mentionsRequestId: String(myToken),
						selectedType: searchType,
						workspaceHint,
					}),
				)
					.then((results) => {
						if (myToken !== latestSearchTokenRef.current) {
							// Stale response — a newer search has been issued.
							return
						}
						setFileSearchResults((results.results || []) as SearchResult[])
						setSearchLoading(false)
					})
					.catch((error) => {
						if (myToken !== latestSearchTokenRef.current) {
							return
						}
						console.error("Error searching files:", error)
						setFileSearchResults([])
						setSearchLoading(false)
					})
			}, 200) // 200ms debounce
		},
		[selectedType],
	)

	return {
		showContextMenu,
		setShowContextMenu,
		selectedMenuIndex,
		setSelectedMenuIndex,
		selectedType,
		setSelectedType,
		searchQuery,
		setSearchQuery,
		cursorPosition,
		setCursorPosition,
		justDeletedSpaceAfterMention,
		setJustDeletedSpaceAfterMention,
		intendedCursorPosition,
		setIntendedCursorPosition,
		contextMenuContainerRef,
		fileSearchResults,
		setFileSearchResults,
		searchLoading,
		setSearchLoading,
		queryItems,
		handleMentionSelect,
		triggerFileSearch,
		latestSearchTokenRef,
	}
}
