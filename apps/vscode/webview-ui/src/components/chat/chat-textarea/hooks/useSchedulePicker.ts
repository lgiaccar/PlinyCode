import { useCallback, useState } from "react"
import { REPEAT_UNITS, type RepeatUnit, type ScheduleRepeat } from "../../scheduleTime"

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
	onSchedulePrompt?: (text: string, images: string[], files: string[], scheduledAt: number, repeat?: ScheduleRepeat) => void,
) {
	const [showSchedulePicker, setShowSchedulePicker] = useState(false)
	const [scheduleTime, setScheduleTime] = useState("")
	// Total sends (1 = no repeat) and the gap between them.
	const [repeatCount, setRepeatCount] = useState(1)
	const [repeatEvery, setRepeatEvery] = useState(1)
	const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>("hours")

	const confirmSchedule = useCallback(() => {
		if (!scheduleTime) return
		const scheduledAt = new Date(scheduleTime).getTime()
		if (Number.isNaN(scheduledAt) || scheduledAt <= Date.now()) return
		const count = Math.max(1, Math.floor(repeatCount) || 1)
		const intervalMs = Math.max(1, repeatEvery) * REPEAT_UNITS[repeatUnit]
		onSchedulePrompt?.(inputValue, selectedImages, selectedFiles, scheduledAt, count > 1 ? { count, intervalMs } : undefined)
		setShowSchedulePicker(false)
		setScheduleTime("")
		setRepeatCount(1)
		setInputValue("")
		setSelectedImages([])
		setSelectedFiles([])
	}, [
		scheduleTime,
		repeatCount,
		repeatEvery,
		repeatUnit,
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
		repeatCount,
		setRepeatCount,
		repeatEvery,
		setRepeatEvery,
		repeatUnit,
		setRepeatUnit,
		confirmSchedule,
	}
}
