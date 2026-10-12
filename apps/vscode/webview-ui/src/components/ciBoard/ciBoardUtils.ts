import type { CiItem, CiPipeline } from "@shared/proto/cline/ci_board"

/** A pull request link the extension can parse; anything else typed into the box is a branch name. */
const PR_LINK = /^https?:\/\/\S+\/(pull|pullrequest)\/\d+/i

type CiInputKind = "pr" | "branch" | "empty"

export function classifyCiInput(text: string): CiInputKind {
	const value = text.trim()
	if (!value) return "empty"
	return PR_LINK.test(value) ? "pr" : "branch"
}

export const DOT_COLORS: Record<string, string> = {
	green: "var(--vscode-testing-iconPassed, #73c991)",
	red: "var(--vscode-testing-iconFailed, #f14c4c)",
	yellow: "var(--vscode-testing-iconQueued, #cca700)",
	grey: "var(--vscode-descriptionForeground, #888)",
}

export function pipelineTitle(p: CiPipeline): string {
	const run = p.runId ? ` · run ${p.runId}` : ""
	if (!p.status) return `${p.name}: no run on this commit`
	if (p.status !== "completed") return `${p.name}: ${p.status === "queued" ? "queued" : "running"}${run}`
	return `${p.name}: ${p.result || "finished"}${run}`
}

export const MERGE_BADGES: Record<string, { label: string; title: string } | undefined> = {
	conflicts: {
		label: "Conflicts",
		title: "The pull request does not merge cleanly into its target branch. Fix conflicts merges the target branch in and resolves them.",
	},
	pending: { label: "Checking merge…", title: "The server is still working out whether the pull request merges cleanly." },
}

export const CONVERSATION_LABELS: Record<string, string> = {
	running: "Running",
	background: "Running in background",
	idle: "Conversation",
}

interface Meta {
	label: string
	icon: string
	color: string
	tip: string
}

export const SEVERITY_META: Record<string, Meta> = {
	blocker: {
		label: "Blocker",
		icon: "codicon-error",
		color: "var(--vscode-errorForeground, #f14c4c)",
		tip: "Blocker: the build fails, so nothing after it was tested.",
	},
	high: {
		label: "High",
		icon: "codicon-warning",
		color: "var(--vscode-testing-iconFailed, #f14c4c)",
		tip: "High: tests fail in a way that looks like a real regression, or the pull request conflicts.",
	},
	medium: {
		label: "Medium",
		icon: "codicon-question",
		color: "var(--vscode-editorWarning-foreground, #cca700)",
		tip: "Medium: something failed, but it is not clear what kind of failure it is. Investigate tells you more.",
	},
	low: {
		label: "Low",
		icon: "codicon-info",
		color: "var(--vscode-editorInfo-foreground, #3794ff)",
		tip: "Low: small test deltas (recalibration) or an infrastructure problem that a re-run usually fixes.",
	},
	info: {
		label: "Info",
		icon: "codicon-clock",
		color: "var(--vscode-descriptionForeground, #888)",
		tip: "Info: the failed run tested an older commit; wait for the run on the current head.",
	},
}

export const CATEGORY_META: Record<string, { label: string; tip: string }> = {
	build: { label: "Build", tip: "Compiling, linking, packaging or lint failed." },
	"test-regression": {
		label: "Test failure",
		tip: "Tests fail in a way that looks like a real defect: a crash, an assertion, or clearly worse results.",
	},
	"small-test-delta": {
		label: "Small delta",
		tip: "Tests fail only because measured values moved slightly. Recalibrate updates their expected values.",
	},
	infrastructure: {
		label: "Infrastructure",
		tip: "An agent, network, disk or service problem unrelated to the code. A re-run usually fixes it.",
	},
	stale: { label: "Stale run", tip: "The run tested an older commit than the pull request's head." },
	unknown: { label: "Unclear", tip: "The failure could not be classified. Investigate looks at it in depth." },
	conflict: { label: "Conflicts", tip: "The pull request does not merge cleanly into its target branch." },
}

export const AUTO_META: Record<string, { label: string; icon: string; tone: "info" | "warning" | "muted" }> = {
	running: { label: "Auto: fixing", icon: "codicon-loading codicon-modifier-spin", tone: "info" },
	queued: { label: "Auto: queued", icon: "codicon-history", tone: "muted" },
	waiting_slot: { label: "Auto: waiting for a slot", icon: "codicon-history", tone: "muted" },
	waiting_ci: { label: "Auto: waiting", icon: "codicon-watch", tone: "muted" },
	capped: { label: "Auto: gave up", icon: "codicon-circle-slash", tone: "warning" },
	needs_you: { label: "Auto: needs you", icon: "codicon-person", tone: "warning" },
	idle: { label: "Auto: watching", icon: "codicon-eye", tone: "muted" },
}

export const AUTO_WATCH_TIP =
	"Auto-watch fixes merge conflicts and recalibrates small test deltas on its own, in the background, on the free FreeAuto model. It works in a separate worktree of the branch, pushes only to the pull request's own branch, never force-pushes, and tries at most twice per commit. Build failures, regressions and infrastructure problems are never fixed automatically: you get a notification instead."

/** What the board knows about an item, worst first, for sorting and the summary chip. */
export function itemRank(item: CiItem): number {
	const severity = item.triage?.severity
	if (severity) return { blocker: 5, high: 4, medium: 3, low: 2, info: 1 }[severity] ?? 0
	if (item.mergeState === "conflicts") return 4
	if (item.pipelines.some((p) => p.color === "red")) return 3
	return 0
}

export function isFailing(item: CiItem): boolean {
	return item.mergeState === "conflicts" || item.pipelines.some((p) => p.color === "red")
}

export function timeAgo(ts: number, now = Date.now()): string {
	const minutes = Math.max(0, Math.round((now - ts) / 60_000))
	if (minutes < 1) return "just now"
	if (minutes < 60) return `${minutes} min ago`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours} h ago`
	return `${Math.round(hours / 24)} d ago`
}
