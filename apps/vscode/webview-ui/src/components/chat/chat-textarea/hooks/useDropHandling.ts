import { StringArrayRequest } from "@shared/proto/cline/common"
import { RelativePathsRequest } from "@shared/proto/cline/file"
import type React from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { CHAT_CONSTANTS } from "@/components/chat/chat-view/constants"
import { FileServiceClient } from "@/services/grpc-client"
import { insertMentionDirectly } from "@/utils/context-mentions"

const { MAX_IMAGES_AND_FILES_PER_MESSAGE } = CHAT_CONSTANTS
const SUPPORTED_IMAGE_URI = /\.(png|jpe?g|webp)(?:$|[?#])/i
const SUPPORTED_IMAGE_FILE = /\.(png|jpe?g|webp)$/i

function isSupportedImageFile(file: File): boolean {
	// Windows Explorer drops in VS Code webviews can leave File.type blank.
	// Fall back to the file name rather than treating an otherwise valid image
	// as plain dropped text or an unsupported file.
	return /^(image\/(png|jpeg|webp))$/i.test(file.type) || SUPPORTED_IMAGE_FILE.test(file.name)
}

function parseUriList(data: string): string[] {
	return data
		.split(/\r?\n/)
		.map((value) => value.trim())
		.filter((value) => value.length > 0 && !value.startsWith("#"))
}

function decodeUri(value: unknown): string | null {
	if (typeof value !== "string") {
		return null
	}
	try {
		return decodeURIComponent(value)
	} catch {
		// A URI containing an invalid escape sequence can still be handled by
		// vscode-uri on the extension side, so retain its original representation.
		return value
	}
}

/** Collects local URI drops from every format currently emitted by VS Code/Cursor. */
function getDroppedUris(dataTransfer: DataTransfer): string[] {
	const values: unknown[] = []
	const resourceUrls = dataTransfer.getData("resourceurls")
	if (resourceUrls) {
		try {
			const parsed: unknown = JSON.parse(resourceUrls)
			if (Array.isArray(parsed)) {
				values.push(...parsed)
			}
		} catch {
			// Older Cursor builds expose resource URLs as a newline-separated list.
			values.push(...parseUriList(resourceUrls))
		}
	}

	for (const type of ["application/vnd.code.uri-list", "text/uri-list", "text/x-uri"]) {
		const value = dataTransfer.getData(type)
		if (value) {
			values.push(...parseUriList(value))
		}
	}

	return [...new Set(values.map(decodeUri).filter((uri): uri is string => !!uri))].filter((uri) =>
		/^(?:vscode-file|file|vscode-remote):/i.test(uri),
	)
}

const getImageDimensions = (dataUrl: string): Promise<{ width: number; height: number }> => {
	return new Promise((resolve, reject) => {
		const img = new Image()
		img.onload = () => {
			if (img.naturalWidth > 7500 || img.naturalHeight > 7500) {
				reject(new Error("Image dimensions exceed maximum allowed size of 7500px."))
			} else {
				resolve({ width: img.naturalWidth, height: img.naturalHeight })
			}
		}
		img.onerror = (err) => {
			console.error("Failed to load image for dimension check:", err)
			reject(new Error("Failed to load image to check dimensions."))
		}
		img.src = dataUrl
	})
}

/**
 * Drag-and-drop and paste handling for files and images dropped/pasted into
 * the chat textarea: the dragging-over outline, unsupported-file and
 * over-dimension error banners (each with its own auto-hide timer), the
 * pending-insertions queue for paths dropped from the VS Code explorer, and
 * the onDrop/onPaste handlers themselves. `inputValue`/`cursorPosition` and
 * their setters, `intendedCursorPosition`'s setter, `textAreaRef`, and
 * `selectedImages`/`selectedFiles` and their setters live in the parent
 * component and are threaded through so this hook doesn't duplicate that
 * state — it's also shared with the context-menu mention insertion.
 */
export function useDropHandling(
	inputValue: string,
	cursorPosition: number,
	setCursorPosition: (position: number) => void,
	setInputValue: (value: string) => void,
	intendedCursorPosition: number | null,
	setIntendedCursorPosition: (position: number | null) => void,
	textAreaRef: React.RefObject<HTMLTextAreaElement | null>,
	selectedImages: string[],
	selectedFiles: string[],
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>,
	shouldDisableFilesAndImages: boolean,
) {
	const [isDraggingOver, setIsDraggingOver] = useState(false)
	const [showUnsupportedFileError, setShowUnsupportedFileError] = useState(false)
	const unsupportedFileTimerRef = useRef<NodeJS.Timeout | null>(null)
	const [showDimensionError, setShowDimensionError] = useState(false)
	const dimensionErrorTimerRef = useRef<NodeJS.Timeout | null>(null)
	const [pendingInsertions, setPendingInsertions] = useState<string[]>([])

	// Effect to detect when drag operation ends outside the component
	useEffect(() => {
		const handleGlobalDragEnd = () => {
			// This will be triggered when the drag operation ends anywhere
			setIsDraggingOver(false)
			// Don't clear error message, let it time out naturally
		}

		document.addEventListener("dragend", handleGlobalDragEnd)

		return () => {
			document.removeEventListener("dragend", handleGlobalDragEnd)
		}
	}, [])

	// Drains one path at a time from files/paths dropped from the VS Code
	// explorer (see onDrop below), inserting each as a mention at the last
	// intended cursor position.
	// Deliberately excludes `intendedCursorPosition` and `textAreaRef` from
	// deps, matching the original effect: it only re-runs when the queue or
	// setInputValue changes, reading the ref/latest cursor value fresh each time.
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional — see comment above
	useEffect(() => {
		if (pendingInsertions.length === 0 || !textAreaRef.current) {
			return
		}

		const path = pendingInsertions[0]
		const currentTextArea = textAreaRef.current
		const currentValue = currentTextArea.value
		const currentCursorPos =
			intendedCursorPosition ?? (currentTextArea.selectionStart >= 0 ? currentTextArea.selectionStart : currentValue.length)

		const { newValue, mentionIndex } = insertMentionDirectly(currentValue, currentCursorPos, path)

		setInputValue(newValue)

		const newCursorPosition = mentionIndex + path.length + 2
		setIntendedCursorPosition(newCursorPosition)

		setPendingInsertions((prev) => prev.slice(1))
	}, [pendingInsertions, setInputValue])

	const showDimensionErrorMessage = useCallback(() => {
		setShowDimensionError(true)
		if (dimensionErrorTimerRef.current) {
			clearTimeout(dimensionErrorTimerRef.current)
		}
		dimensionErrorTimerRef.current = setTimeout(() => {
			setShowDimensionError(false)
			dimensionErrorTimerRef.current = null
		}, 3000)
	}, [])

	const showUnsupportedFileErrorMessage = useCallback(() => {
		// Show error message for unsupported files
		setShowUnsupportedFileError(true)

		// Clear any existing timer
		if (unsupportedFileTimerRef.current) {
			clearTimeout(unsupportedFileTimerRef.current)
		}

		// Set timer to hide error after 3 seconds
		unsupportedFileTimerRef.current = setTimeout(() => {
			setShowUnsupportedFileError(false)
			unsupportedFileTimerRef.current = null
		}, 3000)
	}, [])

	const handlePaste = useCallback(
		async (e: React.ClipboardEvent) => {
			const items = e.clipboardData.items

			const pastedText = e.clipboardData.getData("text")
			// Check if the pasted content is a URL, add space after so user can easily delete if they don't want it
			const urlRegex = /^\S+:\/\/\S+$/
			if (urlRegex.test(pastedText.trim())) {
				e.preventDefault()
				const trimmedUrl = pastedText.trim()
				const newValue = inputValue.slice(0, cursorPosition) + trimmedUrl + " " + inputValue.slice(cursorPosition)
				setInputValue(newValue)
				const newCursorPosition = cursorPosition + trimmedUrl.length + 1
				setCursorPosition(newCursorPosition)
				setIntendedCursorPosition(newCursorPosition)

				// Scroll to new cursor position
				// https://stackoverflow.com/questions/29899364/how-do-you-scroll-to-the-position-of-the-cursor-in-a-textarea/40951875#40951875
				setTimeout(() => {
					if (textAreaRef.current) {
						textAreaRef.current.blur()
						textAreaRef.current.focus()
					}
				}, 0)
				// NOTE: callbacks dont utilize return function to cleanup, but it's fine since this timeout immediately executes and will be cleaned up by the browser (no chance component unmounts before it executes)

				return
			}

			const acceptedTypes = ["png", "jpeg", "webp"] // supported by anthropic and openrouter (jpg is just a file extension but the image will be recognized as jpeg)
			const imageItems = Array.from(items).filter((item) => {
				const [type, subtype] = item.type.split("/")
				return type === "image" && acceptedTypes.includes(subtype)
			})
			if (!shouldDisableFilesAndImages && imageItems.length > 0) {
				e.preventDefault()
				const imagePromises = imageItems.map((item) => {
					return new Promise<string | null>((resolve) => {
						const blob = item.getAsFile()
						if (!blob) {
							resolve(null)
							return
						}
						const reader = new FileReader()
						reader.onloadend = async () => {
							if (reader.error) {
								console.error("Error reading file:", reader.error)
								resolve(null)
							} else {
								const result = reader.result
								if (typeof result === "string") {
									try {
										await getImageDimensions(result)
										resolve(result)
									} catch (error) {
										console.warn((error as Error).message)
										showDimensionErrorMessage()
										resolve(null)
									}
								} else {
									resolve(null)
								}
							}
						}
						reader.readAsDataURL(blob)
					})
				})
				const imageDataArray = await Promise.all(imagePromises)
				const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)
				//.map((dataUrl) => dataUrl.split(",")[1]) // strip the mime type prefix, sharp doesn't need it
				if (dataUrls.length > 0) {
					const filesAndImagesLength = selectedImages.length + selectedFiles.length
					const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

					if (availableSlots > 0) {
						const imagesToAdd = Math.min(dataUrls.length, availableSlots)
						setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
					}
				} else {
					console.warn("No valid images were processed")
				}
			}
		},
		[
			shouldDisableFilesAndImages,
			setSelectedImages,
			selectedImages,
			selectedFiles,
			cursorPosition,
			setInputValue,
			inputValue,
			showDimensionErrorMessage,
			setCursorPosition,
			setIntendedCursorPosition,
			textAreaRef,
		],
	)

	const handleDragEnter = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(true)

			// Check if files are being dragged
			if (e.dataTransfer.types.includes("Files")) {
				// Check if any of the files are not images
				const items = Array.from(e.dataTransfer.items)
				const hasNonImageFile = items.some((item) => {
					if (item.kind === "file") {
						const type = item.type.split("/")[0]
						return type !== "image"
					}
					return false
				})

				if (hasNonImageFile) {
					showUnsupportedFileErrorMessage()
				}
			}
		},
		[showUnsupportedFileErrorMessage],
	)

	/**
	 * Handles the drag over event to allow dropping.
	 * Prevents the default behavior to enable drop.
	 *
	 * @param {React.DragEvent} e - The drag event.
	 */
	const onDragOver = useCallback(
		(e: React.DragEvent) => {
			e.preventDefault()
			e.dataTransfer.dropEffect = "copy"
			// Ensure state remains true if dragging continues over the element
			if (!isDraggingOver) {
				setIsDraggingOver(true)
			}
		},
		[isDraggingOver],
	)

	const handleDragLeave = useCallback((e: React.DragEvent) => {
		e.preventDefault()
		// Check if the related target is still within the drop zone; prevents flickering
		const dropZone = e.currentTarget as HTMLElement
		if (!dropZone.contains(e.relatedTarget as Node)) {
			setIsDraggingOver(false)
			// Don't clear the error message here, let it time out naturally
		}
	}, [])

	/**
	 * Reads image files and returns their data URLs.
	 * Uses FileReader to read the files as data URLs.
	 *
	 * @param {File[]} imageFiles - The image files to read.
	 * @returns {Promise<(string | null)[]>} - A promise that resolves to an array of data URLs or null values.
	 */
	const readImageFiles = useCallback(
		(imageFiles: File[]): Promise<(string | null)[]> => {
			return Promise.all(
				imageFiles.map(
					(file) =>
						new Promise<string | null>((resolve) => {
							const reader = new FileReader()
							reader.onloadend = async () => {
								// Make async
								if (reader.error) {
									console.error("Error reading file:", reader.error)
									resolve(null)
								} else {
									const result = reader.result
									if (typeof result === "string") {
										try {
											await getImageDimensions(result) // Check dimensions
											resolve(result)
										} catch (error) {
											console.warn((error as Error).message)
											showDimensionErrorMessage() // Show error to user
											resolve(null) // Don't add this image
										}
									} else {
										resolve(null)
									}
								}
							}
							reader.readAsDataURL(file)
						}),
				),
			)
		},
		[showDimensionErrorMessage],
	)

	/**
	 * Handles the drop event for text.
	 * Inserts the dropped text at the current cursor position.
	 *
	 * @param {string} text - The dropped text.
	 */
	const handleTextDrop = useCallback(
		(text: string) => {
			const newValue = inputValue.slice(0, cursorPosition) + text + inputValue.slice(cursorPosition)
			setInputValue(newValue)
			const newCursorPosition = cursorPosition + text.length
			setCursorPosition(newCursorPosition)
			setIntendedCursorPosition(newCursorPosition)
		},
		[inputValue, cursorPosition, setInputValue, setCursorPosition, setIntendedCursorPosition],
	)

	/**
	 * Handles the drop event for files and text.
	 * Processes dropped images and text, updating the state accordingly.
	 *
	 * @param {React.DragEvent} e - The drop event.
	 */
	const onDrop = useCallback(
		async (e: React.DragEvent) => {
			e.preventDefault()
			setIsDraggingOver(false) // Reset state on drop

			// Clear any error message when something is actually dropped
			setShowUnsupportedFileError(false)
			if (unsupportedFileTimerRef.current) {
				clearTimeout(unsupportedFileTimerRef.current)
				unsupportedFileTimerRef.current = null
			}

			// --- 1. VSCode Explorer Drop Handling ---
			const validUris = getDroppedUris(e.dataTransfer)

			if (validUris.length > 0) {
				const imageUris = validUris.filter((uri) => SUPPORTED_IMAGE_URI.test(uri))
				const otherUris = validUris.filter((uri) => !imageUris.includes(uri))

				if (imageUris.length > 0 && !shouldDisableFilesAndImages) {
					try {
						const response = await FileServiceClient.readDroppedImages(
							StringArrayRequest.create({ value: imageUris }),
						)
						const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - selectedImages.length - selectedFiles.length
						if (availableSlots > 0) {
							setSelectedImages((previous) => [...previous, ...response.values.slice(0, availableSlots)])
						}
					} catch (error) {
						console.error("Error reading dropped images:", error)
					}
				}

				if (otherUris.length === 0 && imageUris.length > 0) {
					return
				}
				if (otherUris.length > 0) {
					setPendingInsertions([])
					let initialCursorPos = inputValue.length
					if (textAreaRef.current) {
						initialCursorPos = textAreaRef.current.selectionStart
					}
					setIntendedCursorPosition(initialCursorPos)

					FileServiceClient.getRelativePaths(RelativePathsRequest.create({ uris: otherUris }))
						.then((response) => {
							if (response.paths.length > 0) {
								setPendingInsertions((prev) => [...prev, ...response.paths])
							}
						})
						.catch((error) => {
							console.error("Error getting relative paths:", error)
						})
					return
				}
			}

			// --- 3. Native file drop handling ---
			// Windows Explorer commonly supplies both a FileList and text/plain path
			// data. Process the FileList first: otherwise the path text short-circuits
			// the image branch and no thumbnail is attached.
			const files = Array.from(e.dataTransfer.files)
			const imageFiles = files.filter(isSupportedImageFile)

			if (!shouldDisableFilesAndImages && imageFiles.length > 0) {
				const imageDataArray = await readImageFiles(imageFiles)
				const dataUrls = imageDataArray.filter((dataUrl): dataUrl is string => dataUrl !== null)

				if (dataUrls.length > 0) {
					const filesAndImagesLength = selectedImages.length + selectedFiles.length
					const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - filesAndImagesLength

					if (availableSlots > 0) {
						const imagesToAdd = Math.min(dataUrls.length, availableSlots)
						setSelectedImages((prevImages) => [...prevImages, ...dataUrls.slice(0, imagesToAdd)])
					}
				} else {
					console.warn("No valid images were processed")
				}
				return
			}

			const text = e.dataTransfer.getData("text")
			if (text) {
				handleTextDrop(text)
			}
		},
		[
			inputValue,
			handleTextDrop,
			readImageFiles,
			selectedFiles,
			selectedImages,
			setIntendedCursorPosition,
			setSelectedImages,
			shouldDisableFilesAndImages,
			textAreaRef,
		],
	)

	return {
		isDraggingOver,
		setIsDraggingOver,
		showUnsupportedFileError,
		setShowUnsupportedFileError,
		unsupportedFileTimerRef,
		showDimensionError,
		setShowDimensionError,
		dimensionErrorTimerRef,
		pendingInsertions,
		setPendingInsertions,
		handlePaste,
		handleDragEnter,
		onDragOver,
		handleDragLeave,
		onDrop,
	}
}
