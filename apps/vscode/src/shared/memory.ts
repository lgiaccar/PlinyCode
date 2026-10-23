/** Memory values shared by the host, tools and settings panel. */
export const MEMORY_TYPES = ["convention", "gotcha", "decision", "environment", "preference", "reference"] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]
export type MemoryScope = "repo" | "group" | "user"

export interface MemoryEntry {
	id: string
	text: string
	scope: MemoryScope
	importance: "high" | "normal"
	type?: MemoryType
	added?: string
	used?: string
	pinned: boolean
	topicFile?: string
}

export interface MemoryTuning {
	userShare: number
	importantCap: number
	saveCap: number
	staleDays: number
	proposalCount: number
}

export const DEFAULT_MEMORY_TUNING: MemoryTuning = {
	userShare: 25,
	importantCap: 15,
	saveCap: 8,
	staleDays: 90,
	proposalCount: 4,
}
