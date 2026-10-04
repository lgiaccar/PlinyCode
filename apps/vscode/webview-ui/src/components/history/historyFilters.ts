export type DateFilter = "any" | "today" | "last7" | "last30" | "custom"

export const DATE_FILTERS: Record<DateFilter, string> = {
	any: "Any time",
	today: "Today",
	last7: "Last 7 days",
	last30: "Last 30 days",
	custom: "Custom range…",
}

/** The two `datetime-local` values of the custom range ("YYYY-MM-DDTHH:mm", local time; "" = open). */
export type CustomDateRange = { from: string; to: string }

function startOfDay(date: Date, daysAgo = 0): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() - daysAgo).getTime()
}

function parseLocalDateTime(value: string): number {
	const ts = value ? new Date(value).getTime() : 0
	return Number.isFinite(ts) ? ts : 0
}

/**
 * The period a date filter selects, in ms since epoch; 0 leaves that side open.
 * "Last 7 days" counts today as the seventh day.
 */
export function dateFilterRange(
	filter: DateFilter,
	custom: CustomDateRange,
	now: Date = new Date(),
): { fromTs: number; toTs: number } {
	switch (filter) {
		case "today":
			return { fromTs: startOfDay(now), toTs: 0 }
		case "last7":
			return { fromTs: startOfDay(now, 6), toTs: 0 }
		case "last30":
			return { fromTs: startOfDay(now, 29), toTs: 0 }
		case "custom": {
			const toTs = parseLocalDateTime(custom.to)
			// The input has minute precision: include the whole minute it names.
			return { fromTs: parseLocalDateTime(custom.from), toTs: toTs ? toTs + 59_999 : 0 }
		}
		default:
			return { fromTs: 0, toTs: 0 }
	}
}

/**
 * Splits history rows, already in display order, into the sections the list
 * shows: pinned conversations first, then the rest, by day when the list is
 * sorted by date.
 */
export function groupHistoryTasks<T extends { ts: number; isPinned?: boolean }>(
	tasks: T[],
	options: { groupByDay: boolean; now?: Date },
): { tasks: T[]; groupCounts: number[]; groupLabels: string[] } {
	const pinned = tasks.filter((task) => task.isPinned)
	const rest = tasks.filter((task) => !task.isPinned)
	const groups: { label: string; tasks: T[] }[] = []
	if (pinned.length > 0) {
		groups.push({ label: "Pinned", tasks: pinned })
	}
	if (options.groupByDay) {
		const today = (options.now ?? new Date()).toDateString()
		const todayTasks = rest.filter((task) => new Date(task.ts).toDateString() === today)
		const olderTasks = rest.filter((task) => new Date(task.ts).toDateString() !== today)
		if (todayTasks.length > 0) {
			groups.push({ label: "Today", tasks: todayTasks })
		}
		if (olderTasks.length > 0) {
			groups.push({ label: "Older", tasks: olderTasks })
		}
	} else if (rest.length > 0) {
		// Without pins the list is one unlabelled section, as before.
		groups.push({ label: pinned.length > 0 ? "Others" : "", tasks: rest })
	}
	return {
		tasks: groups.flatMap((group) => group.tasks),
		groupCounts: groups.map((group) => group.tasks.length),
		groupLabels: groups.map((group) => group.label),
	}
}
