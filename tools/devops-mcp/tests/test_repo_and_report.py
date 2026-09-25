import pytest

from devops_mcp.errors import DevOpsError
from devops_mcp.providers.github import failure_excerpt
from devops_mcp.repo import Remote, parse_remote
from devops_mcp.report import set_section


@pytest.mark.parametrize(
    "url",
    [
        "git@github.com:octo/hello.git",
        "https://github.com/octo/hello.git",
        "https://github.com/octo/hello",
        "ssh://git@github.com/octo/hello.git",
    ],
)
def test_github_remotes(url):
    assert parse_remote(url) == Remote("github", "github.com", "octo", "hello")


@pytest.mark.parametrize(
    "url",
    [
        "https://dev.azure.com/acme/My%20Project/_git/web-app",
        "https://jdoe@dev.azure.com/acme/My%20Project/_git/web-app",
        "git@ssh.dev.azure.com:v3/acme/My%20Project/web-app",
        "https://acme.visualstudio.com/My%20Project/_git/web-app",
        "https://acme.visualstudio.com/DefaultCollection/My%20Project/_git/web-app",
        "acme@vs-ssh.visualstudio.com:v3/acme/My%20Project/web-app",
    ],
)
def test_ado_remotes(url):
    assert parse_remote(url) == Remote("ado", "dev.azure.com", "acme", "web-app", "My Project")


def test_unknown_host_needs_provider():
    with pytest.raises(DevOpsError, match="DEVOPS_MCP_PROVIDER"):
        parse_remote("git@git.corp.example:team/tool.git")
    assert parse_remote("git@git.corp.example:team/tool.git", "github") == Remote("github", "git.corp.example", "team", "tool")


def test_set_section_appends_then_replaces():
    body = "Hand-written summary."
    once = set_section(body, "ci", "CI: pending")
    assert once == "Hand-written summary.\n\n<!-- devops-mcp:ci -->\nCI: pending\n<!-- /devops-mcp:ci -->\n"
    twice = set_section(once + "\nFooter", "ci", "CI: passed")
    assert "CI: pending" not in twice
    assert twice.startswith("Hand-written summary.") and twice.endswith("Footer")
    assert twice.count("devops-mcp:ci") == 2


def test_set_section_on_empty_body_and_regex_chars_in_content():
    assert set_section("", "ci", r"a \1 b") == "<!-- devops-mcp:ci -->\na \\1 b\n<!-- /devops-mcp:ci -->\n"
    with pytest.raises(DevOpsError):
        set_section("", "bad name", "x")


def test_failure_excerpt_ends_at_last_error():
    log = "\n".join(["setup"] * 5 + ["boom", "##[error]Process completed with exit code 1."] + ["cleanup"] * 20)
    assert failure_excerpt(log, 2) == "boom\n##[error]Process completed with exit code 1."
    assert failure_excerpt("a\nb\nc", 2) == "b\nc"
