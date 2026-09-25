"""Provider-neutral data model and the interface both backends implement."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx

from ..errors import DevOpsError


@dataclass
class PullRequest:
    id: int
    title: str
    body: str
    state: str  # open | closed | merged (ADO: active is reported as open)
    draft: bool
    source_branch: str
    target_branch: str
    author: str
    url: str
    head_sha: str | None = None


@dataclass
class PipelineRun:
    id: int
    name: str
    status: str  # queued | in_progress | completed
    result: str | None  # success | failure | cancelled | partial | skipped | None while running
    branch: str
    commit: str | None
    url: str
    started: str | None
    finished: str | None
    event: str | None = None


@dataclass
class FailedStep:
    job: str
    step: str
    errors: list[str] = field(default_factory=list)
    log_tail: str | None = None


@dataclass
class JobResult:
    name: str
    status: str
    result: str | None
    url: str | None = None


@dataclass
class RunReport:
    run: PipelineRun
    jobs: list[JobResult]
    failures: list[FailedStep]


@dataclass
class Check:
    name: str
    status: str  # queued | in_progress | completed
    result: str | None
    required: bool | None = None
    url: str | None = None


class Auth(Protocol):
    async def headers(self) -> dict[str, str]: ...

    def invalidate(self) -> None: ...


class Http:
    """A thin httpx wrapper: adds auth, retries once on 401 and turns API errors into `DevOpsError`s."""

    def __init__(self, auth: Auth, base_headers: dict[str, str], client: httpx.AsyncClient | None = None) -> None:
        self.auth = auth
        self.base_headers = base_headers
        self.client = client or httpx.AsyncClient(timeout=30, follow_redirects=True)

    async def request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        extra = kwargs.pop("headers", {})
        for attempt in (1, 2):
            headers = {**self.base_headers, **await self.auth.headers(), **extra}
            try:
                resp = await self.client.request(method, url, headers=headers, **kwargs)
            except httpx.HTTPError as exc:
                raise DevOpsError(f"{method} {url} failed: {exc}") from exc
            if resp.status_code == 401 and attempt == 1:
                self.auth.invalidate()
                continue
            break
        if resp.status_code >= 400:
            raise DevOpsError(f"{method} {url} -> HTTP {resp.status_code}: {_error_text(resp)}")
        # An expired or missing ADO credential gets redirected to an HTML sign-in page with 200/203.
        if "text/html" in resp.headers.get("content-type", "") and "json" in headers.get("Accept", "json"):
            raise DevOpsError(f"{method} {url} returned a sign-in page; the credentials were not accepted.")
        return resp

    async def json(self, method: str, url: str, **kwargs: Any) -> Any:
        resp = await self.request(method, url, **kwargs)
        return resp.json() if resp.content else None


def _error_text(resp: httpx.Response) -> str:
    try:
        data = resp.json()
    except ValueError:
        return resp.text[:500]
    if isinstance(data, dict):
        msg = data.get("message") or data.get("Message") or ""
        errors = data.get("errors")
        if errors:
            details = "; ".join(e.get("message") or e.get("code") or str(e) if isinstance(e, dict) else str(e) for e in errors)
            msg = f"{msg} ({details})"
        return msg or str(data)[:500]
    return str(data)[:500]


def tail(text: str, lines: int) -> str:
    return "\n".join(text.rstrip().splitlines()[-lines:])


class Provider(ABC):
    kind: str
    max_body_length: int
    repo_url: str

    @abstractmethod
    async def default_branch(self) -> str: ...

    @abstractmethod
    async def find_open_pr(self, branch: str) -> PullRequest | None: ...

    @abstractmethod
    async def get_pr(self, pr_id: int) -> PullRequest: ...

    @abstractmethod
    async def create_pr(self, title: str, body: str, source: str, target: str, draft: bool) -> PullRequest: ...

    @abstractmethod
    async def update_pr(self, pr_id: int, title: str | None, body: str | None) -> PullRequest: ...

    @abstractmethod
    async def list_runs(self, branch: str | None, pr: PullRequest | None, limit: int) -> list[PipelineRun]: ...

    @abstractmethod
    async def run_report(self, run_id: int, log_lines: int) -> RunReport: ...

    @abstractmethod
    async def pr_checks(self, pr: PullRequest) -> list[Check]: ...

    def check_body(self, body: str) -> None:
        if len(body) > self.max_body_length:
            raise DevOpsError(
                f"The description is {len(body)} characters; {self.kind} allows at most {self.max_body_length}. "
                "Shorten it (e.g. collapse detail into a summary) and try again."
            )
