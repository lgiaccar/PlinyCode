import type { PipelineRun, Provider, PullRequest } from "../../server/providers/types"
import type { CiTarget } from "../types"

export const SHA_A = "a".repeat(40)
export const SHA_B = "b".repeat(40)

export function boardPr(id: number, overrides: Partial<PullRequest> = {}): PullRequest {
	return {
		id,
		title: `PR ${id}`,
		body: "",
		state: "open",
		draft: false,
		sourceBranch: `feature-${id}`,
		targetBranch: "main",
		author: "me",
		url: `https://github.com/octo/hello/pull/${id}`,
		headSha: SHA_A,
		fork: false,
		...overrides,
	}
}

export function boardRun(
	id: number,
	pipeline: string,
	status: PipelineRun["status"],
	result?: string,
	commit = SHA_A,
): PipelineRun {
	return { id, name: pipeline, pipeline, status, result, branch: "x", commit, url: `https://ci/${id}` }
}

/** A provider over in-memory PRs and runs that counts every call. */
export class FakeBoardProvider implements Provider {
	readonly maxBodyLength = 65536
	readonly repoUrl = "https://github.com/octo/hello"
	prs: PullRequest[] = []
	/** Runs by commit. */
	runs = new Map<string, PipelineRun[]>()
	heads = new Map<string, string>()
	rateLimitRemaining?: number
	/** Merge state `getPr` reports; the listing reports none, as GitHub's does. */
	mergeStates = new Map<number, PullRequest["mergeState"]>()
	failList = false
	readonly calls: Record<string, number> = {}

	constructor(readonly kind = "GitHub") {}

	private count(name: string): void {
		this.calls[name] = (this.calls[name] ?? 0) + 1
	}

	get total(): number {
		return Object.values(this.calls).reduce((a, b) => a + b, 0)
	}

	async defaultBranch(): Promise<string> {
		return "main"
	}

	async findOpenPr(branch: string): Promise<PullRequest | undefined> {
		this.count("findOpenPr")
		const pr = this.prs.find((p) => p.sourceBranch === branch)
		return pr ? { ...pr, mergeState: undefined } : undefined
	}

	async getPr(id: number): Promise<PullRequest> {
		this.count("getPr")
		const pr = this.prs.find((p) => p.id === id)
		if (!pr) throw new Error(`GET /pulls/${id} -> HTTP 404: Not Found`)
		return { ...pr, mergeState: this.mergeStates.get(id) ?? "clean" }
	}

	async createPr(): Promise<PullRequest> {
		throw new Error("not used")
	}

	async updatePr(): Promise<PullRequest> {
		throw new Error("not used")
	}

	async listRuns(_branch: string | undefined, pr: PullRequest | undefined): Promise<PipelineRun[]> {
		this.count("listRuns")
		const sha = pr?.headSha ?? this.heads.get(_branch ?? "")
		return sha ? [...(this.runs.get(sha) ?? [])] : []
	}

	async runReport(): Promise<never> {
		throw new Error("not used")
	}

	async prChecks(): Promise<[]> {
		return []
	}

	async listOpenPrs({ mine, limit }: { mine: boolean; limit: number }): Promise<PullRequest[]> {
		this.count("listOpenPrs")
		if (this.failList) throw new Error("GET /pulls -> HTTP 502: Bad Gateway")
		return this.prs
			.filter((p) => p.state === "open" && (!mine || p.author === "me"))
			.slice(0, limit)
			.map((p) => ({ ...p, mergeState: undefined }))
	}

	async branchHead(branch: string): Promise<string | undefined> {
		this.count("branchHead")
		return this.heads.get(branch)
	}
}

export function boardTarget(overrides: Partial<CiTarget> = {}): CiTarget {
	return {
		id: "t1",
		kind: "repo",
		remoteUrl: "https://github.com/octo/hello",
		provider: "github",
		prFilter: "mine",
		autonomy: "manual",
		actions: [],
		createdTs: 0,
		...overrides,
	}
}
