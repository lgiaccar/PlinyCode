import { useCallback, useState } from "react"

/**
 * The schedule-a-message time picker: its open/time state and the confirm
 * handler that hands the current draft off to `onSchedulePrompt` and resets
 * the composer. The draft (`inputValue`/`selectedImages`/`selectedFiles`) and
 * their setters live in the parent component, so they're passed in rather
 * than duplicated here.
 */
export function useSchedulePicker(
	inputValue: string,
	selectedImages: string[],
	selectedFiles: string[],
	setInputValue: (value: string) => void,
	setSelectedImages: React.Dispatch<React.SetStateAction<string[]>>,
	setSelectedFiles: React.Dispatch<React.SetStateAction<string[]>>,
	onSchedulePrompt?: (text: string, images: string[], files: string[], scheduledAt: number) => void,
) {
	const [showSchedulePicker, setShowSchedulePicker] = useState(false)
	const [scheduleTime, setScheduleTime] = useState("")

	const confirmSchedule = useCallback(() => {
		if (!scheduleTime) return
		const scheduledAt = new Date(scheduleTime).getTime()
		if (Number.isNaN(scheduledAt) || scheduledAt <= Date.now()) return
		onSchedulePrompt?.(inputValue, selectedImages, selectedFiles, scheduledAt)
		setShowSchedulePicker(false)
		setScheduleTime("")
		setInputValue("")
		setSelectedImages([])
		setSelectedFiles([])
	}, [
		scheduleTime,
		onSchedulePrompt,
		inputValue,
		selectedImages,
		selectedFiles,
		setInputValue,
		setSelectedImages,
		setSelectedFiles,
	])

	return {
		showSchedulePicker,
		setShowSchedulePicker,
		scheduleTime,
		setScheduleTime,
		confirmSchedule,
	}
}
