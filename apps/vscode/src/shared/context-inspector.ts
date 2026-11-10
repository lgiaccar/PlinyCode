export interface ContextSection {
	label: string
	content: string
	partial: boolean
}
export interface ContextSnapshot {
	id: number
	at: number
	modelId: string
	estimatedTokens: number
	sections: ContextSection[]
	notices: string[]
}
export interface ContextInspection {
	requests: ContextSnapshot[]
	omittedRequests: number
}
