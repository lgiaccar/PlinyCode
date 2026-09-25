"""Markdown rendering for tool results, and marker-delimited sections in PR descriptions."""

from __future__ import annotations

import re
from datetime import datetime

from .errors import DevOpsError
from .providers.base import Check, PipelineRun, PullRequest, RunReport

_ICONS = {"success": "✅", "failure": "❌", "cancelled": "⚪", "skipped": "⚪", "partial": "⚠️", "action_required": "⚠️"}


def icon(status: str, result: str | None) -> str:
    if status != "completed":
        return "⏳"
    return _ICONS.get(result or "", "❔")


def outcome(status: str, result: str | None) -> str:
    return f"{icon(status, result)} {result if status == 'completed' and result else status.replace('_', ' ')}"


def _time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def duration(started: str | None, finished: str | None) -> str:
    a, b = _time(started), _time(finished)
    if not a or not b:
        return ""
    secs = int((b - a).total_seconds())
    return f"{secs // 60}m {secs % 60:02d}s" if secs >= 60 else f"{secs}s"


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def pr_summary(pr: PullRequest, heading: str = "Pull request") -> str:
    draft = " (draft)" if pr.draft else ""
    return (
        f"{heading} #{pr.id}: {pr.title}\n"
        f"- URL: {pr.url}\n"
        f"- State: {pr.state}{draft}\n"
        f"- Branches: {pr.source_branch} → {pr.target_branch}\n"
        f"- Author: {pr.author}"
    )


def runs_table(runs: list[PipelineRun]) -> str:
    if not runs:
        return "No pipeline runs found."
    lines = ["| Run | Result | Branch | Commit | Started | Duration |", "|---|---|---|---|---|---|"]
    for r in runs:
        lines.append(
            f"| [{_cell(r.name)}]({r.url}) (id {r.id}) | {outcome(r.status, r.result)} | {_cell(r.branch)} "
            f"| {(r.commit or '')[:8]} | {(r.started or '')[:16].replace('T', ' ')} | {duration(r.started, r.finished)} |"
        )
    return "\n".join(lines)


def run_report(report: RunReport) -> str:
    r = report.run
    out = [
        f"### {r.name}: {outcome(r.status, r.result)}",
        f"[Open run]({r.url}) · branch `{r.branch}` · commit `{(r.commit or '')[:8]}`"
        + (f" · trigger `{r.event}`" if r.event else "")
        + (f" · {duration(r.started, r.finished)}" if r.finished else ""),
    ]
    if report.jobs:
        out += ["", "| Job | Result |", "|---|---|"]
        out += [f"| {_cell(j.name)} | {outcome(j.status, j.result)} |" for j in report.jobs]
    if report.failures:
        out += ["", "#### Failures"]
        for f in report.failures:
            out += ["", f"**{f.job} › {f.step}**"]
            out += [f"- {e.strip()}" for e in f.errors]
            if f.log_tail:
                out += ["", "```text", f.log_tail.replace("```", "``\u200b`"), "```"]
    elif r.status == "completed" and r.result == "failure":
        out += ["", "The run failed but no failed step was reported (it may have failed during setup)."]
    return "\n".join(out)


def checks_table(pr: PullRequest, checks: list[Check]) -> str:
    if not checks:
        return f"PR #{pr.id} has no checks or policies."
    failing = [c for c in checks if c.status == "completed" and c.result == "failure"]
    pending = [c for c in checks if c.status != "completed"]
    headline = "❌ failing" if failing else "⏳ pending" if pending else "✅ all passing"
    lines = [f"Checks for PR #{pr.id}: {headline} ({len(checks)} total)", "", "| Check | Result | Required |", "|---|---|---|"]
    for c in checks:
        name = f"[{_cell(c.name)}]({c.url})" if c.url else _cell(c.name)
        req = "" if c.required is None else ("yes" if c.required else "no")
        lines.append(f"| {name} | {outcome(c.status, c.result)} | {req} |")
    return "\n".join(lines)


_SECTION_NAME = re.compile(r"^[A-Za-z0-9_-]+$")


def set_section(body: str, name: str, content: str) -> str:
    """Replace the `name` section of a PR description, or append it if it is not there yet.

    A section is delimited by `<!-- devops-mcp:name -->` and `<!-- /devops-mcp:name -->`, which
    render invisibly, so hand-written text around the section is left untouched.
    """
    if not _SECTION_NAME.match(name):
        raise DevOpsError("Section names may only contain letters, digits, '-' and '_'.")
    start, end = f"<!-- devops-mcp:{name} -->", f"<!-- /devops-mcp:{name} -->"
    block = f"{start}\n{content.strip()}\n{end}"
    pattern = re.compile(re.escape(start) + r".*?" + re.escape(end), re.DOTALL)
    if pattern.search(body):
        return pattern.sub(lambda _: block, body, count=1)
    return f"{body.rstrip()}\n\n{block}\n" if body.strip() else f"{block}\n"
