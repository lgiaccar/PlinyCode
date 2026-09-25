import json

import httpx
import pytest


class FakeApi:
    """Routes (METHOD, path) to canned responses and records every request."""

    def __init__(self) -> None:
        self.routes: dict[tuple[str, str], object] = {}
        self.requests: list[httpx.Request] = []

    def on(self, method: str, path: str, body: object = None, status: int = 200, text: str | None = None) -> None:
        self.routes[(method, path)] = (status, body, text)

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        key = (request.method, request.url.path)
        if key not in self.routes:
            return httpx.Response(404, json={"message": f"no fake route for {key}"})
        status, body, text = self.routes[key]
        if text is not None:
            return httpx.Response(status, text=text, headers={"content-type": "text/plain"})
        return httpx.Response(status, json=body)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self._handle))

    def last(self, method: str) -> httpx.Request:
        return [r for r in self.requests if r.method == method][-1]

    def last_json(self, method: str) -> dict:
        return json.loads(self.last(method).content)


@pytest.fixture
def api(monkeypatch) -> FakeApi:
    monkeypatch.setenv("GITHUB_TOKEN", "gh-test-token")
    monkeypatch.setenv("AZURE_DEVOPS_PAT", "ado-test-pat")
    return FakeApi()
