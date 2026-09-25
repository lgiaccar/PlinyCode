"""Tool-level tests against a real temporary git checkout and a fake GitHub API."""

import asyncio
import subprocess

import pytest

from devops_mcp import server
from devops_mcp.errors import DevOpsError
from devops_mcp.providers.github import GitHubProvider
from devops_mcp.repo import Remote

REPO = "/repos/octo/hello"
REMOTE = Remote("github", "github.com", "octo", "hello")


def _git(cwd, *args):
    subprocess.run(["git", "-C", str(cwd), *args], check=True, capture_output=True)


@pytest.fixture
def workspace(tmp_path, api):
    _git(tmp_path, "init", "-q", "-b", "feature")
    _git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init")
    _git(tmp_path, "remote", "add", "origin", "git@github.com:octo/hello.git")
    server._providers[REMOTE] = GitHubProvider(REMOTE, api.client())
    yield tmp_path
    server._providers.clear()


def _pr(body):
    return {"number": 7, "title": "T", "body": body, "state": "open", "draft": False, "head": {"ref": "feature", "sha": "s"},
            "base": {"ref": "main"}, "user": {"login": "u"}, "html_url": "https://github.com/octo/hello/pull/7"}


def test_pr_create_refuses_unpushed_branch(workspace, api):
    with pytest.raises(DevOpsError, match="has not been pushed"):
        asyncio.run(server.pr_create("T", "B", workspace=str(workspace)))
    assert not [r for r in api.requests if r.method == "POST"]


def test_pr_create_defaults_to_current_and_default_branch(workspace, api):
    _git(workspace, "update-ref", "refs/remotes/origin/feature", "HEAD")  # as if pushed
    api.on("GET", f"{REPO}/pulls", [])
    api.on("GET", REPO, {"default_branch": "main"})
    api.on("POST", f"{REPO}/pulls", _pr("B"))
    out = asyncio.run(server.pr_create("T", "B", workspace=str(workspace)))
    assert api.last_json("POST") == {"title": "T", "body": "B", "head": "feature", "base": "main", "draft": True}
    assert "Created pull request #7" in out and "Warning" not in out


def test_pr_update_section_keeps_hand_written_text(workspace, api):
    api.on("GET", f"{REPO}/pulls", [_pr("Hand-written.")])
    api.on("PATCH", f"{REPO}/pulls/7", _pr("ignored"))
    asyncio.run(server.pr_update(body="CI ✅", section="ci", workspace=str(workspace)))
    assert api.last_json("PATCH") == {"body": "Hand-written.\n\n<!-- devops-mcp:ci -->\nCI ✅\n<!-- /devops-mcp:ci -->\n"}


def test_no_open_pr_message(workspace, api):
    api.on("GET", f"{REPO}/pulls", [])
    with pytest.raises(DevOpsError, match="No open pull request for branch 'feature'"):
        asyncio.run(server.pr_get(workspace=str(workspace)))
