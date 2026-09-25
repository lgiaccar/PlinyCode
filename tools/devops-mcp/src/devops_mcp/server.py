"""The MCP server: a small, provider-neutral set of PR and pipeline tools."""

from __future__ import annotations

import logging
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations
from pydantic import Field

from . import report
from .errors import DevOpsError
from .providers.azdo import AzureDevOpsProvider
from .providers.base import Provider, PullRequest
from .providers.github import GitHubProvider
from .repo import Remote, RepoContext, load_context, push_state

INSTRUCTIONS = """\
Pull requests and CI pipelines for the git repository you are working in. The same tools work
for GitHub (Actions) and Azure DevOps (Repos + Pipelines); the backend is chosen from the git remote.

- Call `repo_context` first to see the provider, current branch, default branch and any open PR.
- Pass `workspace` (the absolute path of the repository) on every call when you know it.
- PR descriptions are Markdown. Azure DevOps limits them to 4000 characters, GitHub to 65536.
- To keep generated content (e.g. CI results) current without overwriting hand-written text,
  use `pr_update` with a `section` name; only that section is replaced.
- Pipeline runs take minutes. Do not loop on `pipeline_runs`; check again later when asked.
"""

mcp = MCPServer("devops", instructions=INSTRUCTIONS)

# httpx logs every request at INFO; that is noise in the client's MCP log.
logging.getLogger("httpx").setLevel(logging.WARNING)

Workspace = Annotated[
    str | None,
    Field(description="Absolute path of the git repository. Defaults to DEVOPS_MCP_WORKSPACE or the server's working directory."),
]
PrId = Annotated[int | None, Field(description="PR number/ID. Defaults to the open PR for the current branch.")]

READ_ONLY = ToolAnnotations(read_only_hint=True, open_world_hint=True)

_providers: dict[Remote, Provider] = {}


def _provider(remote: Remote) -> Provider:
    if remote not in _providers:
        _providers[remote] = GitHubProvider(remote) if remote.kind == "github" else AzureDevOpsProvider(remote)
    return _providers[remote]


async def _open(workspace: str | None) -> tuple[RepoContext, Provider]:
    ctx = await load_context(workspace)
    return ctx, _provider(ctx.remote)


async def _resolve_pr(ctx: RepoContext, provider: Provider, pr_id: int | None) -> PullRequest:
    if pr_id is not None:
        return await provider.get_pr(pr_id)
    if not ctx.branch:
        raise DevOpsError("HEAD is detached, so there is no current branch; pass `pr_id`.")
    pr = await provider.find_open_pr(ctx.branch)
    if pr is None:
        raise DevOpsError(f"No open pull request for branch '{ctx.branch}'. Pass `pr_id`, or create one with `pr_create`.")
    return pr


@mcp.tool(annotations=READ_ONLY)
async def repo_context(workspace: Workspace = None) -> str:
    """Show the provider, repository, current and default branch, push state and the open PR for the current branch."""
    ctx, provider = await _open(workspace)
    lines = [
        f"Provider: {provider.kind}",
        f"Repository: {ctx.remote.slug} ({provider.repo_url})",
        f"Local path: {ctx.root}",
        f"Current branch: {ctx.branch or '(detached HEAD)'}",
        f"Default branch: {await provider.default_branch()}",
        f"Max PR description length: {provider.max_body_length} characters",
    ]
    if ctx.branch:
        problem = await push_state(ctx, ctx.branch)
        lines.append(f"Push state: {problem or 'up to date with the remote'}")
        pr = await provider.find_open_pr(ctx.branch)
        lines.append(f"Open PR for this branch: #{pr.id} {pr.title} ({pr.url})" if pr else "Open PR for this branch: none")
    return "\n".join(lines)


@mcp.tool(annotations=ToolAnnotations(destructive_hint=False, open_world_hint=True))
async def pr_create(
    title: str,
    body: Annotated[str, Field(description="PR description in Markdown.")],
    target_branch: Annotated[str | None, Field(description="Branch to merge into. Defaults to the repository's default branch.")] = None,
    source_branch: Annotated[str | None, Field(description="Branch with the changes. Defaults to the current branch.")] = None,
    draft: Annotated[bool, Field(description="Open the PR as a draft.")] = True,
    workspace: Workspace = None,
) -> str:
    """Create a pull request from a pushed branch, with a Markdown description."""
    ctx, provider = await _open(workspace)
    source = source_branch or ctx.branch
    if not source:
        raise DevOpsError("HEAD is detached; pass `source_branch`.")
    provider.check_body(body)
    problem = await push_state(ctx, source)
    if problem and "not been pushed" in problem:
        raise DevOpsError(problem)
    existing = await provider.find_open_pr(source)
    if existing:
        raise DevOpsError(f"Branch '{source}' already has open PR #{existing.id} ({existing.url}). Use `pr_update` to change it.")
    target = target_branch or await provider.default_branch()
    if target == source:
        raise DevOpsError(f"Source and target are both '{source}'. Create a feature branch first.")
    pr = await provider.create_pr(title, body, source, target, draft)
    note = f"\n\nWarning: {problem} The PR does not include them yet." if problem else ""
    return report.pr_summary(pr, "Created pull request") + note


@mcp.tool(annotations=READ_ONLY)
async def pr_get(pr_id: PrId = None, workspace: Workspace = None) -> str:
    """Show a pull request's title, state, branches and full Markdown description."""
    ctx, provider = await _open(workspace)
    pr = await _resolve_pr(ctx, provider, pr_id)
    return f"{report.pr_summary(pr)}\n\n--- description ---\n{pr.body or '(empty)'}"


@mcp.tool(annotations=ToolAnnotations(destructive_hint=True, idempotent_hint=True, open_world_hint=True))
async def pr_update(
    pr_id: PrId = None,
    title: Annotated[str | None, Field(description="New title. Omit to keep the current one.")] = None,
    body: Annotated[
        str | None,
        Field(description="Markdown. Replaces the whole description, or only the named section when `section` is set."),
    ] = None,
    section: Annotated[
        str | None,
        Field(description="Name of a generated section (letters, digits, '-', '_'), e.g. 'ci'. Only that section is replaced; it is appended if missing."),
    ] = None,
    workspace: Workspace = None,
) -> str:
    """Update a pull request's title and/or Markdown description (whole description or one named section)."""
    if title is None and body is None:
        raise DevOpsError("Nothing to update: pass `title` and/or `body`.")
    if section is not None and body is None:
        raise DevOpsError("`section` needs `body` (the new section content).")
    ctx, provider = await _open(workspace)
    pr = await _resolve_pr(ctx, provider, pr_id)
    new_body = report.set_section(pr.body, section, body) if section is not None and body is not None else body
    if new_body is not None:
        provider.check_body(new_body)
    updated = await provider.update_pr(pr.id, title, new_body)
    return report.pr_summary(updated, "Updated pull request")


@mcp.tool(annotations=READ_ONLY)
async def pipeline_runs(
    branch: Annotated[str | None, Field(description="Branch to list runs for. Defaults to the current branch; '*' lists all branches.")] = None,
    pr_id: Annotated[int | None, Field(description="List the runs for this PR (its latest commit / PR build) instead of a branch.")] = None,
    limit: Annotated[int, Field(ge=1, le=50)] = 10,
    workspace: Workspace = None,
) -> str:
    """List recent CI runs (GitHub Actions workflow runs or Azure Pipelines builds), newest first, as a Markdown table."""
    ctx, provider = await _open(workspace)
    pr = await provider.get_pr(pr_id) if pr_id is not None else None
    target = None if branch == "*" else (branch or ctx.branch)
    runs = await provider.list_runs(target, pr, limit)
    scope = f"PR #{pr.id}" if pr else f"branch {target}" if target else "all branches"
    return f"Pipeline runs for {scope} ({provider.kind}):\n\n{report.runs_table(runs)}"


@mcp.tool(annotations=READ_ONLY)
async def pipeline_report(
    run_id: Annotated[int | None, Field(description="Run/build ID from `pipeline_runs`. Defaults to the latest run on the current branch.")] = None,
    log_lines: Annotated[int, Field(ge=0, le=500, description="Lines of log to include from each failed step.")] = 40,
    workspace: Workspace = None,
) -> str:
    """Report one CI run as Markdown: job results, failed steps, their error messages and the tail of their logs."""
    ctx, provider = await _open(workspace)
    if run_id is None:
        runs = await provider.list_runs(ctx.branch, None, 1)
        if not runs:
            raise DevOpsError(f"No pipeline runs found for branch '{ctx.branch}'.")
        run_id = runs[0].id
    return report.run_report(await provider.run_report(run_id, log_lines))


@mcp.tool(annotations=READ_ONLY)
async def pr_checks(pr_id: PrId = None, workspace: Workspace = None) -> str:
    """Show the status checks (GitHub) or branch policies and statuses (Azure DevOps) on a pull request."""
    ctx, provider = await _open(workspace)
    pr = await _resolve_pr(ctx, provider, pr_id)
    return report.checks_table(pr, await provider.pr_checks(pr))


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
