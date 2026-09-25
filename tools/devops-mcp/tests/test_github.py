import asyncio

import pytest

from devops_mcp.errors import DevOpsError
from devops_mcp.providers.github import GitHubProvider
from devops_mcp.repo import Remote

REPO = "/repos/octo/hello"


def _pr(number=7, body="Body", merged=False):
    return {
        "number": number,
        "title": "Add feature",
        "body": body,
        "state": "closed" if merged else "open",
        "merged_at": "2026-09-01T00:00:00Z" if merged else None,
        "draft": True,
        "head": {"ref": "feature", "sha": "abc123def"},
        "base": {"ref": "main"},
        "user": {"login": "octocat"},
        "html_url": "https://github.com/octo/hello/pull/7",
    }


def _provider(api):
    return GitHubProvider(Remote("github", "github.com", "octo", "hello"), api.client())


def test_create_pr_sends_payload_and_token(api):
    api.on("POST", f"{REPO}/pulls", _pr())
    pr = asyncio.run(_provider(api).create_pr("Add feature", "## Summary", "feature", "main", True))
    assert api.last_json("POST") == {"title": "Add feature", "body": "## Summary", "head": "feature", "base": "main", "draft": True}
    assert api.last("POST").headers["Authorization"] == "Bearer gh-test-token"
    assert (pr.id, pr.draft, pr.source_branch, pr.state) == (7, True, "feature", "open")


def test_merged_state_and_update_only_sends_given_fields(api):
    api.on("PATCH", f"{REPO}/pulls/7", _pr(body="new", merged=True))
    pr = asyncio.run(_provider(api).update_pr(7, None, "new"))
    assert api.last_json("PATCH") == {"body": "new"}
    assert pr.state == "merged"


def test_api_error_message_reaches_the_model(api):
    api.on("POST", f"{REPO}/pulls", {"message": "Validation Failed", "errors": [{"message": "A pull request already exists"}]}, 422)
    with pytest.raises(DevOpsError, match="HTTP 422: Validation Failed \\(A pull request already exists\\)"):
        asyncio.run(_provider(api).create_pr("t", "b", "feature", "main", False))


def test_list_runs_for_pr_filters_by_head_sha(api):
    api.on("GET", f"{REPO}/actions/runs", {"workflow_runs": [
        {"id": 1, "name": "ci", "status": "completed", "conclusion": "timed_out", "head_branch": "feature",
         "head_sha": "abc123def", "html_url": "u", "run_started_at": "2026-09-01T10:00:00Z", "updated_at": "2026-09-01T10:02:05Z"},
    ]})
    api.on("GET", f"{REPO}/pulls/7", _pr())
    provider = _provider(api)

    async def run():
        return await provider.list_runs("ignored", await provider.get_pr(7), 5)

    runs = asyncio.run(run())
    assert api.last("GET").url.params["head_sha"] == "abc123def"
    assert "branch" not in api.last("GET").url.params
    assert (runs[0].status, runs[0].result) == ("completed", "failure")


def test_run_report_collects_failed_steps_annotations_and_log(api):
    api.on("GET", f"{REPO}/actions/runs/9", {"id": 9, "name": "ci", "status": "completed", "conclusion": "failure",
                                              "head_branch": "feature", "head_sha": "abc", "html_url": "u"})
    api.on("GET", f"{REPO}/actions/runs/9/jobs", {"jobs": [
        {"id": 100, "name": "lint", "status": "completed", "conclusion": "success", "steps": []},
        {"id": 101, "name": "test", "status": "completed", "conclusion": "failure",
         "steps": [{"name": "checkout", "conclusion": "success"}, {"name": "pytest", "conclusion": "failure"}]},
    ]})
    api.on("GET", f"{REPO}/check-runs/101/annotations", [
        {"annotation_level": "failure", "message": "test_x failed"},
        {"annotation_level": "warning", "message": "deprecated"},
    ])
    api.on("GET", f"{REPO}/actions/jobs/101/logs", text="2026-09-01T10:00:00.1234567Z FAILED test_x\n2026-09-01T10:00:01.0Z ##[error]exit 1\ncleanup")
    report = asyncio.run(_provider(api).run_report(9, 5))
    assert [j.result for j in report.jobs] == ["success", "failure"]
    [failure] = report.failures
    assert (failure.job, failure.step, failure.errors) == ("test", "pytest", ["test_x failed"])
    assert failure.log_tail == "FAILED test_x\n##[error]exit 1"


def test_body_limit(api):
    provider = _provider(api)
    provider.check_body("x" * 65536)
    with pytest.raises(DevOpsError, match="at most 65536"):
        provider.check_body("x" * 65537)
