"""Work out which repository a tool call is about, from the local git checkout."""

from __future__ import annotations

import asyncio
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from urllib.parse import unquote, urlsplit

from .errors import DevOpsError

ProviderKind = Literal["github", "ado"]


@dataclass(frozen=True)
class Remote:
    """A parsed git remote. For GitHub, `owner` is the user/org; for ADO it is the org."""

    kind: ProviderKind
    host: str
    owner: str
    repo: str
    project: str | None = None  # ADO only

    @property
    def slug(self) -> str:
        if self.kind == "ado":
            return f"{self.owner}/{self.project}/{self.repo}"
        return f"{self.owner}/{self.repo}"


@dataclass(frozen=True)
class RepoContext:
    root: Path
    remote_name: str
    remote: Remote
    branch: str | None  # None when HEAD is detached


def _strip_git(name: str) -> str:
    return name[:-4] if name.endswith(".git") else name


def _split_url(url: str) -> tuple[str, str]:
    """Return (host, path) for https://, ssh:// and scp-style (git@host:path) URLs."""
    if "://" in url:
        parts = urlsplit(url)
        return (parts.hostname or "").lower(), parts.path.strip("/")
    m = re.match(r"^(?:[^@/]+@)?([^:/]+):(.+)$", url)
    if not m:
        raise DevOpsError(f"Cannot parse git remote URL: {url}")
    return m.group(1).lower(), m.group(2).strip("/")


def parse_remote(url: str, provider: str | None = None) -> Remote:
    """Parse a git remote URL into a `Remote`.

    Azure DevOps is recognised from dev.azure.com / visualstudio.com hosts and
    github.com is GitHub. Any other host (e.g. GitHub Enterprise Server) needs
    `provider` ("github" or "ado") to say which API it speaks.
    """
    host, path = _split_url(url.strip())
    segments = [unquote(s) for s in path.split("/") if s]

    is_ado = host.endswith("dev.azure.com") or host.endswith("visualstudio.com")
    kind: ProviderKind
    if provider in ("github", "ado"):
        kind = provider  # type: ignore[assignment]
    elif is_ado:
        kind = "ado"
    elif host == "github.com":
        kind = "github"
    else:
        raise DevOpsError(
            f"Unrecognised git host '{host}'. Set DEVOPS_MCP_PROVIDER=github (GitHub Enterprise) "
            "or DEVOPS_MCP_PROVIDER=ado to say which API it uses."
        )

    if kind == "github":
        if len(segments) < 2:
            raise DevOpsError(f"Cannot find owner/repo in GitHub remote URL: {url}")
        return Remote("github", host, segments[-2], _strip_git(segments[-1]))

    # Azure DevOps URL shapes:
    #   https://[user@]dev.azure.com/{org}/{project}/_git/{repo}
    #   https://{org}.visualstudio.com/[DefaultCollection/]{project}/_git/{repo}
    #   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
    #   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
    if segments and segments[0] == "v3" and len(segments) >= 4:
        org, project, repo = segments[1], segments[2], segments[3]
    elif "_git" in segments:
        i = segments.index("_git")
        if i + 1 >= len(segments) or i < 1:
            raise DevOpsError(f"Cannot parse Azure DevOps remote URL: {url}")
        repo = segments[i + 1]
        project = segments[i - 1]
        if host.endswith("visualstudio.com"):
            org = host.split(".")[0]
        elif i >= 2:
            org = segments[i - 2]
        else:
            raise DevOpsError(f"Cannot find the organisation in Azure DevOps remote URL: {url}")
    else:
        raise DevOpsError(f"Cannot parse Azure DevOps remote URL: {url}")
    return Remote("ado", "dev.azure.com", org, _strip_git(repo), project)


def _git(root: Path, *args: str, check: bool = True) -> str | None:
    git = shutil.which("git")
    if not git:
        raise DevOpsError("git is not on PATH.")
    proc = subprocess.run([git, "-C", str(root), *args], capture_output=True, text=True)
    if proc.returncode != 0:
        if check:
            raise DevOpsError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
        return None
    return proc.stdout.strip()


def _resolve_workspace(workspace: str | None) -> Path:
    raw = workspace or os.environ.get("DEVOPS_MCP_WORKSPACE") or os.getcwd()
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise DevOpsError(f"Workspace folder does not exist: {path}")
    return path


def _load_context(workspace: str | None) -> RepoContext:
    start = _resolve_workspace(workspace)
    root_out = _git(start, "rev-parse", "--show-toplevel", check=False)
    if root_out is None:
        raise DevOpsError(
            f"{start} is not inside a git repository. Pass the `workspace` argument with the "
            "absolute path of the repository, or set DEVOPS_MCP_WORKSPACE."
        )
    root = Path(root_out)
    remote_name = os.environ.get("DEVOPS_MCP_REMOTE", "origin")
    url = _git(root, "remote", "get-url", remote_name, check=False)
    if url is None:
        raise DevOpsError(f"The repository at {root} has no remote named '{remote_name}' (set DEVOPS_MCP_REMOTE).")
    remote = parse_remote(url, os.environ.get("DEVOPS_MCP_PROVIDER"))
    branch = _git(root, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    return RepoContext(root, remote_name, remote, branch or None)


async def load_context(workspace: str | None) -> RepoContext:
    return await asyncio.to_thread(_load_context, workspace)


def _push_state(ctx: RepoContext, branch: str) -> str | None:
    """Return a problem description if `branch` is not fully pushed, else None."""
    ref = f"refs/remotes/{ctx.remote_name}/{branch}"
    if _git(ctx.root, "rev-parse", "--verify", "--quiet", ref, check=False) is None:
        return f"Branch '{branch}' has not been pushed. Run `git push -u {ctx.remote_name} {branch}` first."
    if ctx.branch == branch:
        ahead = _git(ctx.root, "rev-list", "--count", f"{ref}..HEAD", check=False)
        if ahead and ahead != "0":
            return f"Branch '{branch}' has {ahead} local commit(s) not pushed to {ctx.remote_name}."
    return None


async def push_state(ctx: RepoContext, branch: str) -> str | None:
    return await asyncio.to_thread(_push_state, ctx, branch)
