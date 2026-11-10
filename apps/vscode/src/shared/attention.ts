export type AttentionStatus = "approval" | "question" | "attention" | "running" | "review" | "reviewed" | "error"
export interface AttentionTask {
	id: string
	title: string
	updatedAt: number
	status: AttentionStatus
}
export interface AttentionSnapshot {
	tasks: AttentionTask[]
	omitted: number
	workspace: string
}
