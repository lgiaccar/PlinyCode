"""Azure DevOps Services (dev.azure.com) Repos + Pipelines via the REST API (7.1)."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..auth import AdoAuth
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

API_VERSION = "7.1"

_RESULTS = {
    "succeeded": "success",
    "succeededWithIssues": "partial",
    "partiallySucceeded": "partial",
    "failed": "failure",
    "canceled": "cancelled",
    "abandoned": "cancelled",
    "skipped": "skipped",
    "none": None,
}

_POLICY = {
    "approved": ("completed", "success"),
    "rejected": ("completed", "failure"),
    "broken": ("completed", "failure"),
    "notApplicable": ("completed", "skipped"),
    "running": ("in_progress", None),
    "queued": ("queued", None),
}

_PR_STATUS = {
    "succeeded": ("completed", "success"),
    "failed": ("completed", "failure"),
    "error": ("completed", "failure"),
    "notApplicable": ("completed", "skipped"),
    "pending": ("in_progress", None),
    "notSet": ("queued", None),
}


def _result(value: str | None) -> str | None:
    return _RESULTS.get(value, value) if value else None


def _status(value: str | None) -> str:
    if value == "completed":
        return "completed"
    if value in ("inProgress", "cancelling"):
        return "in_progress"
    return "queued"


def _short(ref: str | None) -> str:
    return (ref or "").removeprefix("refs/heads/")


class AzureDevOpsProvider(Provider):
    kind = "Azure DevOps"
    # ADO rejects pull request descriptions longer than 4000 characters.
    max_body_length = 4000

    def __init__(self, remote: Remote, client: httpx.AsyncClient | None = None) -> None:
        self.remote = remote
        self.org_url = f"https://dev.azure.com/{quote(remote.owner, safe='')}"
        self.project_url = f"{self.org_url}/{quote(remote.project or '', safe='')}"
        self.repo_url = f"{self.project_url}/_git/{quote(remote.repo, safe='')}"
        self.http = Http(AdoAuth(), {"Accept": "application/json"}, client)
        self._repo: dict[str, Any] | None = None

    async def _api(self, method: str, path: str, params: dict[str, Any] | None = None, **kwargs: Any) -> Any:
        query = {"api-version": API_VERSION, **(params or {})}
        return await self.http.json(method, f"{self.project_url}/_apis/{path}", params=query, **kwargs)

    async def _repo_info(self) -> dict[str, Any]:
        if self._repo is None:
            self._repo = await self._api("GET", f"git/repositories/{quote(self.remote.repo, safe='')}")
        return self._repo

    async def _pr_path(self, suffix: str = "") -> str:
        repo = await self._repo_info()
        return f"git/repositories/{repo['id']}/pullrequests{suffix}"

    def _pr(self, d: dict[str, Any]) -> PullRequest:
        state = {"active": "open", "completed": "merged", "abandoned": "closed"}.get(d.get("status", ""), d.get("status", ""))
        return PullRequest(
            id=d["pullRequestId"],
            title=d.get("title", ""),
            body=d.get("description") or "",
            state=state,
            draft=bool(d.get("isDraft")),
            source_branch=_short(d.get("sourceRefName")),
            target_branch=_short(d.get("targetRefName")),
            author=(d.get("createdBy") or {}).get("displayName", ""),
            url=f"{self.repo_url}/pullrequest/{d['pullRequestId']}",
            head_sha=(d.get("lastMergeSourceCommit") or {}).get("commitId"),
        )

    def _run(self, d: dict[str, Any]) -> PipelineRun:
        return PipelineRun(
            id=d["id"],
            name=f"{(d.get('definition') or {}).get('name', 'build')} #{d.get('buildNumber', d['id'])}",
            status=_status(d.get("status")),
            result=_result(d.get("result")) if d.get("status") == "completed" else None,
            branch=_short(d.get("sourceBranch")),
            commit=d.get("sourceVersion"),
            url=((d.get("_links") or {}).get("web") or {}).get("href")
            or f"{self.project_url}/_build/results?buildId={d['id']}",
            started=d.get("startTime") or d.get("queueTime"),
            finished=d.get("finishTime"),
            event=d.get("reason"),
        )

    async def default_branch(self) -> str:
        branch = _short((await self._repo_info()).get("defaultBranch"))
        if not branch:
            raise DevOpsError("The Azure DevOps repository has no default branch yet.")
        return branch

    async def find_open_pr(self, branch: str) -> PullRequest | None:
        data = await self._api(
            "GET",
            await self._pr_path(),
            {"searchCriteria.sourceRefName": f"refs/heads/{branch}", "searchCriteria.status": "active"},
        )
        prs = data.get("value", [])
        return self._pr(prs[0]) if prs else None

    async def get_pr(self, pr_id: int) -> PullRequest:
        return self._pr(await self._api("GET", await self._pr_path(f"/{pr_id}")))

    async def create_pr(self, title: str, body: str, source: str, target: str, draft: bool) -> PullRequest:
        payload = {
            "sourceRefName": f"refs/heads/{source}",
            "targetRefName": f"refs/heads/{target}",
            "title": title,
            "description": body,
            "isDraft": draft,
        }
        return self._pr(await self._api("POST", await self._pr_path(), json=payload))

    async def update_pr(self, pr_id: int, title: str | None, body: str | None) -> PullRequest:
        payload = {k: v for k, v in (("title", title), ("description", body)) if v is not None}
        return self._pr(await self._api("PATCH", await self._pr_path(f"/{pr_id}"), json=payload))

    async def list_runs(self, branch: str | None, pr: PullRequest | None, limit: int) -> list[PipelineRun]:
        repo = await self._repo_info()
        params: dict[str, Any] = {
            "$top": limit,
            "queryOrder": "queueTimeDescending",
            "repositoryId": repo["id"],
            "repositoryType": "TfsGit",
        }
        if pr is not None:
            params["branchName"] = f"refs/pull/{pr.id}/merge"
        elif branch:
            params["branchName"] = f"refs/heads/{branch}"
        data = await self._api("GET", "build/builds", params)
        return [self._run(b) for b in data.get("value", [])]

    async def run_report(self, run_id: int, log_lines: int) -> RunReport:
        run = self._run(await self._api("GET", f"build/builds/{run_id}"))
        timeline = await self._api("GET", f"build/builds/{run_id}/timeline") or {}
        records = sorted(timeline.get("records") or [], key=lambda r: (r.get("order") or 0))
        by_id = {r["id"]: r for r in records}

        def job_of(rec: dict[str, Any]) -> str:
            cur: dict[str, Any] | None = rec
            while cur is not None and cur.get("type") != "Job":
                cur = by_id.get(cur.get("parentId"))
            return cur["name"] if cur else "(unknown job)"

        jobs = [
            JobResult(r["name"], _status(r.get("state")), _result(r.get("result")), f"{run.url}&view=logs&j={r['id']}")
            for r in records
            if r.get("type") == "Job"
        ]
        failures: list[FailedStep] = []
        for r in records:
            if r.get("type") != "Task" or r.get("result") != "failed":
                continue
            errors = [i["message"] for i in r.get("issues") or [] if i.get("type") == "error"][:20]
            log = await self._log(run_id, (r.get("log") or {}).get("id"), log_lines)
            failures.append(FailedStep(job_of(r), r["name"], errors, log))
        return RunReport(run, jobs, failures)

    async def _log(self, run_id: int, log_id: int | None, lines: int) -> str | None:
        if log_id is None or lines <= 0:
            return None
        try:
            resp = await self.http.request(
                "GET",
                f"{self.project_url}/_apis/build/builds/{run_id}/logs/{log_id}",
                params={"api-version": API_VERSION},
                headers={"Accept": "text/plain"},
            )
        except DevOpsError:
            return None
        return tail(resp.text, lines)

    async def pr_checks(self, pr: PullRequest) -> list[Check]:
        repo = await self._repo_info()
        artifact = f"vstfs:///CodeReview/CodeReviewId/{repo['project']['id']}/{pr.id}"
        data = await self._api("GET", "policy/evaluations", {"artifactId": artifact, "api-version": "7.1-preview.1"})
        checks: list[Check] = []
        for ev in data.get("value", []):
            cfg = ev.get("configuration") or {}
            name = (cfg.get("settings") or {}).get("displayName") or (cfg.get("type") or {}).get("displayName", "policy")
            status, result = _POLICY.get(ev.get("status", ""), ("queued", None))
            build_id = (ev.get("context") or {}).get("buildId")
            url = f"{self.project_url}/_build/results?buildId={build_id}" if build_id else None
            checks.append(Check(name, status, result, bool(cfg.get("isBlocking")), url))

        # External CI systems report through PR statuses; keep only the newest per context.
        statuses = (await self._api("GET", await self._pr_path(f"/{pr.id}/statuses"))).get("value", [])
        latest: dict[str, dict[str, Any]] = {}
        for s in sorted(statuses, key=lambda s: s.get("id", 0)):
            ctx = s.get("context") or {}
            latest["/".join(p for p in (ctx.get("genre"), ctx.get("name")) if p)] = s
        for name, s in latest.items():
            status, result = _PR_STATUS.get(s.get("state", ""), ("queued", None))
            checks.append(Check(name, status, result, None, s.get("targetUrl")))
        return checks
