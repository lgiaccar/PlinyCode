import asyncio
import base64

import pytest

from devops_mcp.errors import DevOpsError
from devops_mcp.providers.azdo import AzureDevOpsProvider
from devops_mcp.repo import Remote

PROJ = "/acme/My Project/_apis"
REPO_ID = "r-1"
PRS = f"{PROJ}/git/repositories/{REPO_ID}/pullrequests"


def _provider(api):
    api.on("GET", f"{PROJ}/git/repositories/web-app", {
        "id": REPO_ID, "defaultBranch": "refs/heads/main", "project": {"id": "p-1"},
    })
    return AzureDevOpsProvider(Remote("ado", "dev.azure.com", "acme", "web-app", "My Project"), api.client())


def _pr(**extra):
    return {
        "pullRequestId": 42, "title": "Add feature", "description": "Body", "status": "active", "isDraft": True,
        "sourceRefName": "refs/heads/feature", "targetRefName": "refs/heads/main",
        "createdBy": {"displayName": "Jane Doe"}, "lastMergeSourceCommit": {"commitId": "abc"}, **extra,
    }


def test_create_pr_uses_refs_and_pat_basic_auth(api):
    provider = _provider(api)
    api.on("POST", PRS, _pr())
    pr = asyncio.run(provider.create_pr("Add feature", "## Summary", "feature", "main", True))
    assert api.last_json("POST") == {
        "sourceRefName": "refs/heads/feature", "targetRefName": "refs/heads/main",
        "title": "Add feature", "description": "## Summary", "isDraft": True,
    }
    req = api.last("POST")
    assert req.url.params["api-version"] == "7.1"
    assert req.headers["Authorization"] == "Basic " + base64.b64encode(b":ado-test-pat").decode()
    assert (pr.id, pr.state, pr.source_branch) == (42, "open", "feature")
    assert pr.url == "https://dev.azure.com/acme/My%20Project/_git/web-app/pullrequest/42"


def test_default_branch_and_find_open_pr(api):
    provider = _provider(api)
    api.on("GET", PRS, {"value": [_pr()]})

    async def run():
        return await provider.default_branch(), await provider.find_open_pr("feature")

    branch, pr = asyncio.run(run())
    assert branch == "main"
    params = api.last("GET").url.params
    assert params["searchCriteria.sourceRefName"] == "refs/heads/feature"
    assert params["searchCriteria.status"] == "active"
    assert pr.id == 42


def test_description_limit_is_4000(api):
    provider = _provider(api)
    provider.check_body("x" * 4000)
    with pytest.raises(DevOpsError, match="Azure DevOps allows at most 4000"):
        provider.check_body("x" * 4001)


def test_list_runs_for_pr_uses_merge_ref(api):
    provider = _provider(api)
    api.on("GET", f"{PRS}/42", _pr())
    api.on("GET", f"{PROJ}/build/builds", {"value": [
        {"id": 7, "buildNumber": "20260901.1", "definition": {"name": "CI"}, "status": "completed", "result": "partiallySucceeded",
         "sourceBranch": "refs/pull/42/merge", "sourceVersion": "abc", "reason": "pullRequest",
         "_links": {"web": {"href": "https://dev.azure.com/acme/My%20Project/_build/results?buildId=7"}}},
        {"id": 8, "buildNumber": "20260901.2", "definition": {"name": "CI"}, "status": "inProgress", "result": "none"},
    ]})

    async def run():
        pr = await provider.get_pr(42)
        return await provider.list_runs(None, pr, 5)

    runs = asyncio.run(run())
    params = api.last("GET").url.params
    assert params["branchName"] == "refs/pull/42/merge"
    assert params["$top"] == "5" and params["repositoryId"] == REPO_ID
    assert [(r.name, r.status, r.result) for r in runs] == [("CI #20260901.1", "completed", "partial"), ("CI #20260901.2", "in_progress", None)]


def test_run_report_walks_timeline_to_job_and_fetches_task_log(api):
    provider = _provider(api)
    api.on("GET", f"{PROJ}/build/builds/7", {"id": 7, "buildNumber": "1", "definition": {"name": "CI"},
                                             "status": "completed", "result": "failed", "sourceBranch": "refs/heads/feature"})
    api.on("GET", f"{PROJ}/build/builds/7/timeline", {"records": [
        {"id": "s", "parentId": None, "type": "Stage", "name": "Build", "state": "completed", "result": "failed", "order": 1},
        {"id": "p", "parentId": "s", "type": "Phase", "name": "Build", "state": "completed", "result": "failed", "order": 1},
        {"id": "j", "parentId": "p", "type": "Job", "name": "Linux", "state": "completed", "result": "failed", "order": 1},
        {"id": "t1", "parentId": "j", "type": "Task", "name": "Restore", "state": "completed", "result": "succeeded", "order": 1},
        {"id": "t2", "parentId": "j", "type": "Task", "name": "Run tests", "state": "completed", "result": "failed", "order": 2,
         "log": {"id": 12}, "issues": [{"type": "error", "message": "3 tests failed"}, {"type": "warning", "message": "slow"}]},
    ]})
    api.on("GET", f"{PROJ}/build/builds/7/logs/12", text="line1\nline2\nline3")
    report = asyncio.run(provider.run_report(7, 2))
    assert [(j.name, j.result) for j in report.jobs] == [("Linux", "failure")]
    [failure] = report.failures
    assert (failure.job, failure.step, failure.errors, failure.log_tail) == ("Linux", "Run tests", ["3 tests failed"], "line2\nline3")
    assert api.last("GET").headers["Accept"] == "text/plain"


def test_pr_checks_merges_policies_and_latest_statuses(api):
    provider = _provider(api)
    api.on("GET", f"{PROJ}/policy/evaluations", {"value": [
        {"status": "rejected", "context": {"buildId": 7},
         "configuration": {"isBlocking": True, "type": {"displayName": "Build"}, "settings": {"displayName": "CI build"}}},
        {"status": "approved", "configuration": {"isBlocking": False, "type": {"displayName": "Minimum number of reviewers"}}},
    ]})
    api.on("GET", f"{PRS}/42/statuses", {"value": [
        {"id": 1, "state": "pending", "context": {"genre": "sonar", "name": "quality"}},
        {"id": 2, "state": "succeeded", "context": {"genre": "sonar", "name": "quality"}, "targetUrl": "https://sonar"},
    ]})
    from devops_mcp.providers.base import PullRequest

    pr = PullRequest(42, "t", "", "open", False, "feature", "main", "", "u")
    checks = asyncio.run(provider.pr_checks(pr))
    assert api.requests[-2].url.params["artifactId"] == "vstfs:///CodeReview/CodeReviewId/p-1/42"
    assert [(c.name, c.result, c.required) for c in checks] == [
        ("CI build", "failure", True),
        ("Minimum number of reviewers", "success", False),
        ("sonar/quality", "success", None),
    ]
    assert checks[0].url.endswith("buildId=7")


def test_html_sign_in_page_is_reported_as_auth_failure(api):
    provider = AzureDevOpsProvider(Remote("ado", "dev.azure.com", "acme", "web-app", "My Project"), api.client())
    api.routes[("GET", f"{PROJ}/git/repositories/web-app")] = (203, None, None)

    import httpx

    def sign_in(request):
        api.requests.append(request)
        return httpx.Response(203, text="<html>Sign in</html>", headers={"content-type": "text/html"})

    provider.http.client = httpx.AsyncClient(transport=httpx.MockTransport(sign_in))
    with pytest.raises(DevOpsError, match="sign-in page"):
        asyncio.run(provider.default_branch())
