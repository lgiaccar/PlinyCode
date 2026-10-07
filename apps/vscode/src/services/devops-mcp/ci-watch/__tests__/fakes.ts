import type { PipelineRun, Provider, PullRequest, RunReport } from "../../server/providers/types"
import type { RepoContext } from "../../server/repo"
import type { CiWatchConversationHost, CiWatchDelivery } from "../ci-watch-manager"
import type { CiWatchClock } from "../ci-watcher"

/** Lets promise chains started by a timer callback run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 50; i++) {
		await Promise.resolve()
	}
}

/** Fake timers: time only moves in `advance`, which runs the timers that come due in order. */
export class FakeClock implements CiWatchClock {
	private time = 0
	private nextId = 1
	private timers: { id: number; at: number; callback: () => void }[] = []

	now(): number {
		return this.time
	}

	setTimeout(callback: () => void, ms: number): unknown {
		const id = this.nextId++
		this.timers.push({ id, at: this.time + ms, callback })
		return id
	}

	clearTimeout(handle: unknown): void {
		this.timers = this.timers.filter((timer) => timer.id !== handle)
	}

	get pending(): number {
		return this.timers.length
	}

	async advance(ms: number): Promise<void> {
		const end = this.time + ms
		for (;;) {
			const due = this.timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
			if (!due) {
				break
			}
			this.timers = this.timers.filter((timer) => timer !== due)
			this.time = due.at
			due.callback()
			await settle()
		}
		this.time = end
		await settle()
	}
}

export const SECOND = 1000
export const MINUTE = 60 * SECOND

export const HEAD_A = "a".repeat(40)
export const HEAD_B = "b".repeat(40)

export function run(id: number, status: PipelineRun["status"], result?: string, commit = HEAD_A): PipelineRun {
	return {
		id,
		name: `workflow-${id}`,
		status,
		result,
		branch: "feature",
		commit,
		url: `https://github.com/octo/hello/actions/runs/${id}`,
	}
}

/** A provider whose pull request, runs and reports the test sets directly. */
export class FakeProvider implements Provider {
	readonly kind = "GitHub"
	readonly maxBodyLength = 65536
	readonly repoUrl = "https://github.com/octo/hello"
	pr: PullRequest | undefined = {
		id: 7,
		title: "T",
		body: "",
		state: "open",
		draft: false,
		sourceBranch: "feature",
		targetBranch: "main",
		author: "u",
		url: "https://github.com/octo/hello/pull/7",
		headSha: HEAD_A,
	}
	runs: PipelineRun[] = []
	reports = new Map<number, RunReport>()
	/** How many of the next `listRuns` calls fail. */
	failNext = 0
	polls = 0

	async defaultBranch(): Promise<string> {
		return "main"
	}

	async findOpenPr(branch: string): Promise<PullRequest | undefined> {
		return this.pr?.sourceBranch === branch ? this.pr : undefined
	}

	async getPr(id: number): Promise<PullRequest> {
		if (!this.pr || this.pr.id !== id) {
			throw new Error(`GET /pulls/${id} -> HTTP 404: Not Found`)
		}
		return { ...this.pr }
	}

	async createPr(): Promise<PullRequest> {
		throw new Error("not used")
	}

	async updatePr(): Promise<PullRequest> {
		throw new Error("not used")
	}

	async listRuns(branch: string | undefined, pr: PullRequest | undefined): Promise<PipelineRun[]> {
		// A pull request is listed twice per poll (by PR and by branch); count the poll once.
		if (pr || !this.pr) {
			this.polls++
			if (this.failNext > 0) {
				this.failNext--
				throw new Error("GET /actions/runs -> HTTP 502: Bad Gateway")
			}
		}
		return this.runs.filter((r) => (pr ? r.commit === pr.headSha : r.branch === branch))
	}

	async runReport(runId: number): Promise<RunReport> {
		const report = this.reports.get(runId)
		if (!report) {
			throw new Error(`no report for run ${runId}`)
		}
		return report
	}

	async prChecks(): Promise<[]> {
		return []
	}

	async listOpenPrs(): Promise<PullRequest[]> {
		return this.pr ? [{ ...this.pr }] : []
	}

	async branchHead(branch: string): Promise<string | undefined> {
		return this.runs.find((r) => r.branch === branch)?.commit
	}
}

export function fakeContext(root = "/nowhere", detached = false): RepoContext {
	return {
		root,
		remoteName: "origin",
		remote: { kind: "github", host: "github.com", owner: "octo", repo: "hello" },
		branch: detached ? undefined : "feature",
	}
}

/** A conversation host that records what the manager asks of it. */
export class FakeHost implements CiWatchConversationHost {
	delivered: { conversationId: string; prompt: string }[] = []
	rows: { conversationId: string; text: string }[] = []
	notifications: { conversationId: string; message: string }[] = []
	/** What `deliver` answers; a function is asked on every call. */
	delivery: CiWatchDelivery | (() => CiWatchDelivery) = "started"

	async deliver(conversationId: string, prompt: string): Promise<CiWatchDelivery> {
		const delivery = typeof this.delivery === "function" ? this.delivery() : this.delivery
		if (delivery === "started" || delivery === "queued") {
			this.delivered.push({ conversationId, prompt })
		}
		return delivery
	}

	showRow(conversationId: string, text: string): void {
		this.rows.push({ conversationId, text })
	}

	notify(conversationId: string, message: string): void {
		this.notifications.push({ conversationId, message })
	}
}
