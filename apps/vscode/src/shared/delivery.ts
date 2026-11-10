export type DeliveryCategory = "checks" | "pullRequest" | "ci" | "release"

export interface DeliveryEvidence {
	id: string
	category: DeliveryCategory
	tool: string
	input: string
	output: string
	failed: boolean
	at?: number
	truncated: boolean
}

export interface DeliverySnapshot {
	evidence: DeliveryEvidence[]
	omitted: number
	remote?: {
		branch: string
		checkedAt: number
		pr?: { id: number; state: string; url: string; head?: string }
		checks: { name: string; status: string; result?: string }[]
	}
	remoteError?: string
}
