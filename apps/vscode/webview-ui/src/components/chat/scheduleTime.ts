/**
 * Helpers for the schedule-a-prompt picker. The picker value is a local
 * "YYYY-MM-DDTHH:MM" string (the `datetime-local` wire format), but the UI
 * shows the time as two 24-hour selects so it never falls back to AM/PM.
 */

const pad2 = (n: number) => String(n).padStart(2, "0")

interface ScheduleTimeParts {
	date: string // YYYY-MM-DD
	hour: number // 0–23
	minute: number // 0–59
}

/** Formats a Date as a local "YYYY-MM-DDTHH:MM" string. */
export function toScheduleTime(date: Date): string {
	return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

/** Default pick: the next 5-minute boundary at least 5 minutes from now. */
export function defaultScheduleTime(now: Date = new Date()): string {
	const d = new Date(now.getTime() + 5 * 60_000)
	d.setSeconds(0, 0)
	d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5)
	return toScheduleTime(d)
}

export function parseScheduleTime(value: string): ScheduleTimeParts | undefined {
	const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value)
	if (!match) {
		return undefined
	}
	return { date: match[1], hour: Number(match[2]), minute: Number(match[3]) }
}

/** Parts of `value`, or of the default pick when `value` is empty or malformed. */
export function scheduleTimeParts(value: string, now: Date = new Date()): ScheduleTimeParts {
	return parseScheduleTime(value) ?? (parseScheduleTime(defaultScheduleTime(now)) as ScheduleTimeParts)
}

export function composeScheduleTime({ date, hour, minute }: ScheduleTimeParts): string {
	return `${date}T${pad2(hour)}:${pad2(minute)}`
}

/** "Sep 26, 21:30": 24-hour display for scheduled prompts. */
export function formatScheduledAt(ts: number): string {
	return new Date(ts).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	})
}
