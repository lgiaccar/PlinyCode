import type { MemoryEntry, MemoryTuning } from "./memory"
import type { MemoryProposal } from "./memory-proposal"

export interface MemoryPanelState {
	entries: MemoryEntry[]
	pending: MemoryProposal[]
	budget: string | number
	distill: "off" | "offer" | "auto"
	tuning: MemoryTuning
	group?: string
	adoption: { key: string; identity: string }[]
	selection?: {
		text: string
		relevant: string
		tokens: number
		budget: number
		loaded: { id: string; tier: string }[]
		cut: MemoryEntry[]
	}
	usage: Record<string, { count?: number; used?: string }>
}
