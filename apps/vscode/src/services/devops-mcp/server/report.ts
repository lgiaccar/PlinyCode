/** Markdown rendering for tool results, and marker-delimited sections in PR descriptions. */
import { DevOpsError } from "./errors"
import type { Check, PipelineRun, PullRequest, Result, RunReport, Status } from "./providers/types"

const ICONS: Record<string, string> = {
	success: "✅",
	failure: "❌",
	cancelled: "⚪",
	skipped: "⚪",
	partial: "⚠️",
	action_required: "⚠️",
}

export function outcome(status: Status, result: Result): string {
	if (status !== "completed") {
		return `⏳ ${status.replace("_", " ")}`
	}
	return `${ICONS[result ?? ""] ?? "❔"} ${result ?? "unknown"}`
}

export function duration(started?: string, finished?: string): string {
	const a = started ? Date.parse(started) : Number.NaN
	const b = finished ? Date.parse(finished) : Number.NaN
	if (Number.isNaN(a) || Number.isNaN(b)) {
		return ""
	}
	const secs = Math.round((b - a) / 1000)
	return secs >= 60 ? `${Math.floor(secs / 60)}m ${String(secs % 60).padStart(2, "0")}s` : `${secs}s`
}

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ")

export function prSummary(pr: PullRequest, heading = "Pull request"): string {
	return [
		`${heading} #${pr.id}: ${pr.title}`,
		`- URL: ${pr.url}`,
		`- State: ${pr.state}${pr.draft ? " (draft)" : ""}`,
		`- Branches: ${pr.sourceBranch} → ${pr.targetBranch}`,
		`- Author: ${pr.author}`,
	].join("\n")
}

export function runsTable(runs: PipelineRun[]): string {
	if (!runs.length) {
		return "No pipeline runs found."
	}
	const rows = runs.map(
		(r) =>
			`| [${cell(r.name)}](${r.url}) (id ${r.id}) | ${outcome(r.status, r.result)} | ${cell(r.branch)} | ${(r.commit ?? "").slice(0, 8)} | ${(r.started ?? "").slice(0, 16).replace("T", " ")} | ${duration(r.started, r.finished)} |`,
	)
	return ["| Run | Result | Branch | Commit | Started | Duration |", "|---|---|---|---|---|---|", ...rows].join("\n")
}

export function runReport(report: RunReport): string {
	const r = report.run
	const meta = [`[Open run](${r.url})`, `branch \`${r.branch}\``, `commit \`${(r.commit ?? "").slice(0, 8)}\``]
	if (r.event) meta.push(`trigger \`${r.event}\``)
	if (r.finished) meta.push(duration(r.started, r.finished))
	const out = [`### ${r.name}: ${outcome(r.status, r.result)}`, meta.join(" · ")]
	if (report.jobs.length) {
		out.push(
			"",
			"| Job | Result |",
			"|---|---|",
			...report.jobs.map((j) => `| ${cell(j.name)} | ${outcome(j.status, j.result)} |`),
		)
	}
	if (report.failures.length) {
		out.push("", "#### Failures")
		for (const f of report.failures) {
			out.push("", `**${f.job} › ${f.step}**`, ...f.errors.map((e) => `- ${e.trim()}`))
			if (f.logTail) {
				out.push("", "```text", f.logTail.replace(/```/g, "``​`"), "```")
			}
		}
	} else if (r.status === "completed" && r.result === "failure") {
		out.push("", "The run failed but no failed step was reported (it may have failed during setup).")
	}
	return out.join("\n")
}

export function checksTable(pr: PullRequest, checks: Check[]): string {
	if (!checks.length) {
		return `PR #${pr.id} has no checks or policies.`
	}
	const failing = checks.some((c) => c.status === "completed" && c.result === "failure")
	const pending = checks.some((c) => c.status !== "completed")
	const headline = failing ? "❌ failing" : pending ? "⏳ pending" : "✅ all passing"
	const rows = checks.map((c) => {
		const name = c.url ? `[${cell(c.name)}](${c.url})` : cell(c.name)
		const required = c.required === undefined ? "" : c.required ? "yes" : "no"
		return `| ${name} | ${outcome(c.status, c.result)} | ${required} |`
	})
	return [
		`Checks for PR #${pr.id}: ${headline} (${checks.length} total)`,
		"",
		"| Check | Result | Required |",
		"|---|---|---|",
		...rows,
	].join("\n")
}

const SECTION_NAME = /^[A-Za-z0-9_-]+$/

/**
 * Replaces the `name` section of a PR description, or appends it when missing.
 *
 * A section sits between `<!-- devops-mcp:name -->` and `<!-- /devops-mcp:name -->`,
 * which render invisibly, so hand-written text around it is left untouched.
 */
export function setSection(body: string, name: string, content: string): string {
	if (!SECTION_NAME.test(name)) {
		throw new DevOpsError("Section names may only contain letters, digits, '-' and '_'.")
	}
	const start = `<!-- devops-mcp:${name} -->`
	const end = `<!-- /devops-mcp:${name} -->`
	const block = `${start}\n${content.trim()}\n${end}`
	const from = body.indexOf(start)
	const to = from >= 0 ? body.indexOf(end, from) : -1
	if (from >= 0 && to >= 0) {
		return body.slice(0, from) + block + body.slice(to + end.length)
	}
	return body.trim() ? `${body.trimEnd()}\n\n${block}\n` : `${block}\n`
}
