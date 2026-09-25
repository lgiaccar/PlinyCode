"""GitHub (github.com and GitHub Enterprise Server) via the REST API."""

from __future__ import annotations

import re
from typing import Any

import httpx

from ..auth import GitHubAuth
from ..errors import DevOpsError
from ..repo import Remote
from .base import (
    Check,
    FailedStep,
    Http,
    JobResult,
    PipelineRun,
    Provider,
    PullRequest,
    RunReport,
    tail,
)

_TIMESTAMP = re.compile(r"^\d{4}-\d\d-\d\dT[\d:.]+Z ", re.MULTILINE)

_RESULTS = {
    "success": "success",
    "failure": "failure",
    "timed_out": "failure",
    "startup_failure": "failure",
    "cancelled": "cancelled",
    "skipped": "skipped",
    "neutral": "skipped",
    "stale": "skipped",
    "action_required": "action_required",
    "error": "failure",  # commit status API
}


def failure_excerpt(log: str, lines: int) -> str:
    """The `lines` lines ending at the last `##[error]` line of a job log.

    GitHub serves one log per job, and its tail is post-job cleanup; the useful output
    is what the failing step printed just before the runner recorded the error.
    """
    all_lines = log.rstrip().splitlines()
    errors = [i for i, line in enumerate(all_lines) if "##[error]" in line]
    if not errors:
        return tail(log, lines)
    end = errors[-1] + 1
    return "\n".join(all_lines[max(0, end - lines) : end])


def _result(value: str | None) -> str | None:
    return _RESULTS.get(value, value) if value else None


def _status(value: str | None) -> str:
    if value == "completed":
        return "completed"
    if value == "in_progress":
        return "in_progress"
    return "queued"


class GitHubProvider(Provider):
    kind = "GitHub"
    max_body_length = 65536

    def __init__(self, remote: Remote, client: httpx.AsyncClient | None = None) -> None:
        self.remote = remote
        api = "https://api.github.com" if remote.host == "github.com" else f"https://{remote.host}/api/v3"
        self.api = f"{api}/repos/{remote.owner}/{remote.repo}"
        self.repo_url = f"https://{remote.host}/{remote.owner}/{remote.repo}"
        self.http = Http(
            GitHubAuth(remote.host),
            {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
            client,
        )

    async def _get(self, path: str, **params: Any) -> Any:
        return await self.http.json("GET", f"{self.api}{path}", params=params or None)

    def _pr(self, d: dict[str, Any]) -> PullRequest:
        state = "merged" if d.get("merged_at") else d["state"]
        return PullRequest(
            id=d["number"],
            title=d["title"],
            body=d.get("body") or "",
            state=state,
            draft=bool(d.get("draft")),
            source_branch=d["head"]["ref"],
            target_branch=d["base"]["ref"],
            author=(d.get("user") or {}).get("login", ""),
            url=d["html_url"],
            head_sha=d["head"]["sha"],
        )

    def _run(self, d: dict[str, Any]) -> PipelineRun:
        return PipelineRun(
            id=d["id"],
            name=d.get("name") or d.get("display_title") or str(d["id"]),
            status=_status(d.get("status")),
            result=_result(d.get("conclusion")),
            branch=d.get("head_branch") or "",
            commit=d.get("head_sha"),
            url=d["html_url"],
            started=d.get("run_started_at") or d.get("created_at"),
            finished=d.get("updated_at") if d.get("status") == "completed" else None,
            event=d.get("event"),
        )

    async def default_branch(self) -> str:
        return (await self._get(""))["default_branch"]

    async def find_open_pr(self, branch: str) -> PullRequest | None:
        prs = await self._get("/pulls", head=f"{self.remote.owner}:{branch}", state="open")
        return self._pr(prs[0]) if prs else None

    async def get_pr(self, pr_id: int) -> PullRequest:
        return self._pr(await self._get(f"/pulls/{pr_id}"))

    async def create_pr(self, title: str, body: str, source: str, target: str, draft: bool) -> PullRequest:
        payload = {"title": title, "body": body, "head": source, "base": target, "draft": draft}
        return self._pr(await self.http.json("POST", f"{self.api}/pulls", json=payload))

    async def update_pr(self, pr_id: int, title: str | None, body: str | None) -> PullRequest:
        payload = {k: v for k, v in (("title", title), ("body", body)) if v is not None}
        return self._pr(await self.http.json("PATCH", f"{self.api}/pulls/{pr_id}", json=payload))

    async def list_runs(self, branch: str | None, pr: PullRequest | None, limit: int) -> list[PipelineRun]:
        params: dict[str, Any] = {"per_page": limit}
        if pr is not None and pr.head_sha:
            params["head_sha"] = pr.head_sha
        elif branch:
            params["branch"] = branch
        data = await self._get("/actions/runs", **params)
        return [self._run(r) for r in data.get("workflow_runs", [])[:limit]]

    async def run_report(self, run_id: int, log_lines: int) -> RunReport:
        run = self._run(await self._get(f"/actions/runs/{run_id}"))
        jobs_data = (await self._get(f"/actions/runs/{run_id}/jobs", filter="latest", per_page=100)).get("jobs", [])
        jobs = [
            JobResult(j["name"], _status(j.get("status")), _result(j.get("conclusion")), j.get("html_url"))
            for j in jobs_data
        ]
        failures: list[FailedStep] = []
        for j in jobs_data:
            if _result(j.get("conclusion")) != "failure":
                continue
            steps = [s["name"] for s in j.get("steps") or [] if _result(s.get("conclusion")) == "failure"]
            errors = await self._annotations(j["id"])
            log = await self._job_log(j["id"], log_lines)
            failures.append(FailedStep(j["name"], ", ".join(steps) or "(job)", errors, log))
        return RunReport(run, jobs, failures)

    async def _annotations(self, job_id: int) -> list[str]:
        # A job's id is also its check-run id; failure annotations carry the error messages.
        try:
            notes = await self._get(f"/check-runs/{job_id}/annotations", per_page=50)
        except DevOpsError:
            return []
        return [n["message"] for n in notes if n.get("annotation_level") == "failure"][:20]

    async def _job_log(self, job_id: int, lines: int) -> str | None:
        if lines <= 0:
            return None
        try:
            resp = await self.http.request("GET", f"{self.api}/actions/jobs/{job_id}/logs")
        except DevOpsError:
            return None  # logs expire or are not ready yet; the report is still useful without them
        return failure_excerpt(_TIMESTAMP.sub("", resp.text), lines)

    async def pr_checks(self, pr: PullRequest) -> list[Check]:
        sha = pr.head_sha or (await self.get_pr(pr.id)).head_sha
        runs = (await self._get(f"/commits/{sha}/check-runs", per_page=100)).get("check_runs", [])
        checks = [
            Check(r["name"], _status(r.get("status")), _result(r.get("conclusion")), None, r.get("html_url"))
            for r in runs
        ]
        statuses = (await self._get(f"/commits/{sha}/status")).get("statuses", [])
        for s in statuses:
            done = s["state"] != "pending"
            checks.append(
                Check(s["context"], "completed" if done else "in_progress", _result(s["state"]) if done else None, None, s.get("target_url"))
            )
        return checks
