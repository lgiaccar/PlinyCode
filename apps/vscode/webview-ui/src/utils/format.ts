import prettyBytes from "pretty-bytes"

export function formatLargeNumber(num: number): string {
	if (num >= 1e9) {
		return (num / 1e9).toFixed(1) + "b"
	}
	if (num >= 1e6) {
		return (num / 1e6).toFixed(1) + "m"
	}
	if (num >= 1e3) {
		return (num / 1e3).toFixed(1) + "k"
	}
	return num.toString()
}

export function formatSize(bytes?: number) {
	if (bytes === undefined) {
		return "--kb"
	}

	return prettyBytes(bytes)
}

/** Compact duration, e.g. "45s", "12m 5s", "2h 3m", "1d 4h". */
export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000))
	const days = Math.floor(totalSeconds / 86400)
	const hours = Math.floor((totalSeconds % 86400) / 3600)
	const minutes = Math.floor((totalSeconds % 3600) / 60)
	const seconds = totalSeconds % 60
	if (days > 0) {
		return hours > 0 ? `${days}d ${hours}h` : `${days}d`
	}
	if (hours > 0) {
		return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`
	}
	if (minutes > 0) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
	}
	return `${seconds}s`
}

/**
 * When a conversation was created, always with the day so it can be told apart
 * from others: "Today, 5:53 PM", "Yesterday, 9:02 AM", "Sep 21, 5:53 PM", and
 * the year too once it is not the current one ("Dec 30, 2025, 5:53 PM").
 */
export function formatStartTime(timestamp: number, now: number = Date.now()): string {
	const date = new Date(timestamp)
	const today = new Date(now)
	const yesterday = new Date(now)
	yesterday.setDate(today.getDate() - 1)
	const time = date.toLocaleString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
	if (date.toDateString() === today.toDateString()) {
		return `Today, ${time}`
	}
	if (date.toDateString() === yesterday.toDateString()) {
		return `Yesterday, ${time}`
	}
	const day = date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
	})
	return `${day}, ${time}`
}
