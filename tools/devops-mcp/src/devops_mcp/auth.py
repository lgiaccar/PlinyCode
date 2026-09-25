"""Credentials: an environment variable if set, otherwise reuse a one-time CLI login.

GitHub: GITHUB_TOKEN / GH_TOKEN, else `gh auth token` (after a one-time `gh auth login`).
Azure DevOps: AZURE_DEVOPS_PAT / AZURE_DEVOPS_EXT_PAT, else an Entra token from
`az account get-access-token` (after a one-time `az login`).

The CLIs own the browser login, token refresh and secure storage on every platform,
so this module never stores a secret itself.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import subprocess
import time

from .errors import DevOpsError

# Well-known Entra application ID of Azure DevOps; tokens for it work against its REST API.
ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798"


def _run_cli(name: str, args: list[str], login_hint: str) -> str:
    exe = shutil.which(name)
    if not exe:
        raise DevOpsError(f"No credentials found and the `{name}` CLI is not installed. {login_hint}")
    proc = subprocess.run([exe, *args], capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        detail = proc.stderr.strip().splitlines()[-1] if proc.stderr.strip() else "no output"
        raise DevOpsError(f"`{name} {' '.join(args[:2])}` failed ({detail}). {login_hint}")
    return proc.stdout.strip()


class GitHubAuth:
    def __init__(self, host: str) -> None:
        self.host = host
        self._token: str | None = None

    def _token_sync(self) -> str:
        env = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
        if env:
            return env
        hint = f"Run `gh auth login --hostname {self.host}` once, or set GITHUB_TOKEN."
        return _run_cli("gh", ["auth", "token", "--hostname", self.host], hint)

    async def headers(self) -> dict[str, str]:
        if self._token is None:
            self._token = await asyncio.to_thread(self._token_sync)
        return {"Authorization": f"Bearer {self._token}"}

    def invalidate(self) -> None:
        self._token = None


class AdoAuth:
    def __init__(self) -> None:
        self._header: str | None = None
        self._expires_at = 0.0

    def _fetch_sync(self) -> tuple[str, float]:
        pat = os.environ.get("AZURE_DEVOPS_PAT") or os.environ.get("AZURE_DEVOPS_EXT_PAT")
        if pat:
            basic = base64.b64encode(f":{pat}".encode()).decode()
            return f"Basic {basic}", float("inf")
        hint = "Run `az login` once (use `az login --use-device-code` on a headless machine), or set AZURE_DEVOPS_PAT."
        out = _run_cli("az", ["account", "get-access-token", "--resource", ADO_RESOURCE_ID, "-o", "json"], hint)
        data = json.loads(out)
        expires = float(data.get("expires_on") or (time.time() + 30 * 60))
        return f"Bearer {data['accessToken']}", expires

    async def headers(self) -> dict[str, str]:
        # Refresh a few minutes early so a long pipeline query never runs on an expiring token.
        if self._header is None or time.time() > self._expires_at - 300:
            self._header, self._expires_at = await asyncio.to_thread(self._fetch_sync)
        return {"Authorization": self._header}

    def invalidate(self) -> None:
        self._header = None
