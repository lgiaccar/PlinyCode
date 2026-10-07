import type { CiPipeline } from "@shared/proto/cline/ci_board"

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
	conflicts: { label: "Conflicts", title: "The pull request conflicts with its target branch." },
	pending: { label: "Checking merge…", title: "The server is still working out whether the pull request merges cleanly." },
}

export const CONVERSATION_LABELS: Record<string, string> = {
	running: "Running",
	background: "Running in background",
	idle: "Conversation",
}

export const AUTONOMY_OPTIONS = [
	{ value: "manual", label: "Manual", title: "Notify when CI fails or the PR conflicts; run actions on click." },
	{ value: "auto", label: "Auto (coming)", title: "Start the action automatically, asking for approvals as usual." },
	{ value: "full_auto", label: "Full auto (coming)", title: "Start the action automatically and approve its tool calls." },
]
