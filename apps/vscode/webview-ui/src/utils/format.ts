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

// Helper to format cents as dollars with 2 decimal places
export function formatDollars(cents?: number): string {
	if (cents === undefined) {
		return ""
	}

	return (cents / 100).toFixed(2)
}

/**
 * Converts microcredits to credits for display purposes.
 *
 * The backend stores credit balances in microcredits (1 credit = 10,000 microcredits)
 * to avoid floating point precision issues when performing calculations.
 * This function converts the microcredits back to the user-facing credit amount.
 *
 * @param microcredits - The balance in microcredits from the backend
 * @returns The balance in credits (typically displayed with 4 decimal places)
 *
 * @example
 * formatCreditsBalance(50000) // returns 5.0000 (credits)
 * formatCreditsBalance(12345) // returns 1.2345 (credits)
 */
export function formatCreditsBalance(microcredits: number): number {
	return microcredits / 10000
}

export function formatTimestamp(timestamp: string): string {
	const date = new Date(timestamp)

	const dateFormatter = new Intl.DateTimeFormat("en-US", {
		month: "2-digit",
		day: "2-digit",
		year: "2-digit",
		hour: "numeric",
		minute: "2-digit",
		hour12: true,
	})

	return dateFormatter.format(date)
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
