"""Black-box portable-package acceptance tests. Python standard library only.

Run from a clean directory: python e2e.py --package /path/to/plinycode-linux-x64
No checkout, installed Bun/Node, gateway credentials, or Python packages needed.
"""

import argparse
import concurrent.futures
import contextlib
import hashlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest

MODEL = "snps-provider-vmodels/glm-5.3"
SECRET = "e2e-injected-secret-never-export"
PARSER = argparse.ArgumentParser()
PARSER.add_argument("--package", required=True, type=Path)
ARGS, TEST_ARGS = PARSER.parse_known_args()
PACKAGE = ARGS.package.resolve()
RESULT = {"judgement": "fail", "summary": "One test failed", "evidence": ["FAILED mesh"]}


@contextlib.contextmanager
def gateway(turns):
    requests = []
    stop = threading.Event()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append(body)
            turn = turns[min(len(requests) - 1, len(turns) - 1)]
            if isinstance(turn, dict) and "http_error" in turn:
                self.send_response(turn["http_error"])
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": "fixture rejection"}}).encode())
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if turn == "HANG":
                stop.wait(45)
                return
            if isinstance(turn, dict):
                deltas = [{"tool_calls": [{"index": 0, "id": "call_fixture", "type": "function",
                           "function": {"name": turn["name"], "arguments": json.dumps(turn["input"])}}]}]
                finish = "tool_calls"
            else:
                # Deliberately split credentials across network chunks.
                deltas = [{"content": turn[i:i + 3]} for i in range(0, len(turn), 3)]
                finish = "stop"
            try:
                for delta in deltas + [{}]:
                    chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": MODEL,
                             "choices": [{"index": 0, "delta": delta,
                                          "finish_reason": None if delta else finish}]}
                    if not delta:
                        chunk["usage"] = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                    self.wfile.flush()
                self.wfile.write(b"data: [DONE]\n\n")
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/api/llm", requests
    finally:
        stop.set()
        server.shutdown()
        server.server_close()
        worker.join(5)


class PortableAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # CI places this script and archive in runner.temp, outside the checkout.
        cls.temp = tempfile.TemporaryDirectory(prefix="plinycode-e2e-")
        cls.root = Path(cls.temp.name)
        cls.package = cls.root / "portable package & unicode-é"
        shutil.copytree(PACKAGE, cls.package)
        cls.runtime = cls.package / "runtime" / ("bun.exe" if os.name == "nt" else "bun")
        cls.entry = cls.package / "plinycode.js"
        cls.command = [str(cls.runtime), "--use-system-ca", str(cls.entry)]
        cls.env = {key: value for key, value in os.environ.items()
                   if not key.startswith(("PLINY", "CLINE", "NODE_", "BUN_"))}
        support = cls.root / "path"
        support.mkdir()
        if os.name == "nt":
            system = Path(os.environ["SystemRoot"]) / "System32"
            search = [cls.package, system, system / "WindowsPowerShell" / "v1.0"]
        else:
            os.symlink(shutil.which("dirname"), support / "dirname")
            search = [cls.package, support]
        cls.env.update(PATH=os.pathsep.join(map(str, search)), PLINY_API_KEY=SECRET,
                       HOME=str(cls.root / "home"), USERPROFILE=str(cls.root / "home"))
        assert shutil.which("bun", path=cls.env["PATH"]) is None
        assert shutil.which("node", path=cls.env["PATH"]) is None

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.workspace = self.root / self._testMethodName
        self.workspace.mkdir()
        self.schema = self.workspace / "schema.json"
        self.schema.write_text(json.dumps({"type": "object", "required": ["judgement"],
                                         "properties": {"judgement": {"enum": ["pass", "fail"]}}}), encoding="utf-8")

    def invoke(self, args, turns, expected=0, stdin=None, model=MODEL):
        with gateway(turns) as (url, requests):
            child = subprocess.run(self.command + ["run"] + (["--model", model] if model else []) + ["--cwd", str(self.workspace),
                                   "--timeout", "15"] + args,
                                   env={**self.env, "PLINY_BASE_URL": url}, cwd=self.workspace,
                                   input=stdin, capture_output=True, text=True, encoding="utf-8", timeout=40)
        self.assertEqual(child.returncode, expected, child.stdout + child.stderr)
        self.assertNotIn(SECRET, child.stdout + child.stderr)
        return child, requests

    def test_skills_agents_listing_and_delegation(self):
        skills = self.workspace / ".github" / "skills" / "review"
        agents = self.workspace / ".github" / "agents"
        skills.mkdir(parents=True)
        agents.mkdir(parents=True)
        (skills / "SKILL.md").write_text("---\nname: review\ndescription: Review evidence\n---\nPORTABLE_SKILL_MARKER", encoding="utf-8")
        (agents / "reviewer.md").write_text("---\nname: reviewer\ndescription: Review evidence\ntools: [read_files, skills]\nskills: [review]\n---\nPORTABLE_AGENT_MARKER", encoding="utf-8")
        for command, expected_name in [("skills", "review"), ("agents", "reviewer")]:
            env = {key: value for key, value in self.env.items() if key != "PLINY_API_KEY"}
            result = subprocess.run(self.command + [command, "--cwd", str(self.workspace), "--json"], env=env, capture_output=True, text=True, encoding="utf-8", timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)["items"][0]["name"], expected_name)
        delegate = {"name": "subagent_reviewer", "input": {"prompt": "Review evidence"}}
        skill = {"name": "skills", "input": {"skill": "review"}}
        result, requests = self.invoke(["--prompt", "Delegate", "--allow-tools", "--json"], [delegate, skill, "CHILD_REPORT", "LEAD_REPORT"], model=None)
        self.assertEqual(json.loads(result.stdout)["result"], "LEAD_REPORT")
        self.assertIn("PORTABLE_AGENT_MARKER", json.dumps(requests[1]))
        self.assertIn("PORTABLE_SKILL_MARKER", json.dumps(requests[2]))
        self.assertIn("CHILD_REPORT", json.dumps(requests[3]))
        denied, denied_requests = self.invoke(["--prompt", "Delegate", "--json"], [delegate], expected=3)
        self.assertEqual(len(denied_requests), 1)

    def test_default_free_auto_and_explicit_model_override(self):
        child, requests = self.invoke(["--prompt", "Analyse the failing pipeline", "--output-schema", str(self.schema), "--stream"],
                                      [json.dumps(RESULT)], model=None)
        events = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertTrue(any(event["type"] == "routing" for event in events))
        self.assertEqual(events[-1]["result"], RESULT)
        self.assertEqual(requests[0]["model"], "snps-provider/kimi-k2.6")
        _, requests = self.invoke(["--prompt", "Analyse", "--json"], ["Done"])
        self.assertEqual(requests[0]["model"], MODEL)

    def test_free_auto_failover_and_schema_repair(self):
        child, requests = self.invoke(["--prompt", "Analyse pipeline logs", "--output-schema", str(self.schema), "--json"],
                                      [{"http_error": 400}, "not JSON", json.dumps(RESULT)], model=None)
        self.assertEqual(json.loads(child.stdout)["result"], RESULT)
        self.assertEqual(requests[0]["model"], "snps-provider/kimi-k2.6")
        self.assertNotEqual(requests[0]["model"], requests[1]["model"])
        self.assertFalse(requests[-1].get("tools"))
        self.assertNotEqual(requests[-1]["model"], requests[-2]["model"])
        self.assertTrue(all(request["model"].startswith("snps-provider") for request in requests))

    def test_free_auto_auth_failure_and_exhaustion(self):
        for status, limit in [(401, 1), (400, 4)]:
            with self.subTest(status=status):
                child, requests = self.invoke(["--prompt", "Analyse", "--json"], [{"http_error": status}], expected=1, model=None)
                self.assertEqual(json.loads(child.stdout)["status"], "failed")
                self.assertEqual(len(requests), limit)

    def test_free_auto_keeps_tool_approvals_and_timeout(self):
        target = self.workspace / "denied.txt"
        child, _ = self.invoke(["--prompt", "Write a file", "--json"],
                               [{"name": "editor", "input": {"path": str(target), "new_text": "denied"}}], expected=3, model=None)
        self.assertFalse(target.exists())
        self.assertEqual(json.loads(child.stdout)["status"], "needs_input")
        child, _ = self.invoke(["--prompt", "Wait", "--json", "--timeout", "1"], ["HANG"], expected=124, model=None)
        self.assertEqual(json.loads(child.stdout)["error"]["code"], "timeout")

    def test_archive_hashes_and_launchers(self):
        for line in (self.package / "SHA256SUMS").read_text().splitlines():
            digest, name = line.split("  ", 1)
            self.assertEqual(hashlib.sha256((self.package / name).read_bytes()).hexdigest(), digest, name)
        if os.name == "nt":
            launcher = self.package / "plinycode.cmd"
            # Exercise the documented PowerShell entry point, including a spaced package path.
            command = ["powershell.exe", "-NoProfile", "-Command", "& $env:CLI_LAUNCHER --help; exit $LASTEXITCODE"]
        else:
            launcher = self.package / "plinycode"
            command = [str(launcher), "--help"]
        result = subprocess.run(command, env={**self.env, "CLI_LAUNCHER": str(launcher)}, cwd=self.workspace,
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("PlinyCode CLI", result.stdout)

    def test_pipeline_analysis_and_python_example(self):
        log = self.workspace / "test results & metrics.log"
        log.write_text("FAILED mesh\nPASSED boundary", encoding="utf-8")
        child, requests = self.invoke(["--file", str(log), "--stdin", "--json", "--output-schema", str(self.schema)],
                                     [json.dumps(RESULT)], stdin="metrics: 1 failed, 1 passed")
        self.assertEqual(json.loads(child.stdout)["result"], RESULT)
        self.assertIn("FAILED mesh", json.dumps(requests[0]))
        self.assertIn("metrics: 1 failed", json.dumps(requests[0]))
        with gateway([json.dumps(RESULT)]) as (url, _):
            result = subprocess.run([sys.executable, str(self.package / "examples/analyse.py"), str(log)],
                                    env={**self.env, "PLINY_BASE_URL": url}, cwd=self.workspace,
                                    capture_output=True, text=True, encoding="utf-8", timeout=40)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(json.loads(result.stdout)["result"], RESULT)

    def test_report_artifact_and_transcript(self):
        report = self.workspace / "report.md"
        transcript = self.workspace / "transcript.md"
        child, _ = self.invoke(["--prompt", "Build report", "--allow-tools", "--json", "--export", str(transcript),
                                "--artifacts-dir", str(self.workspace)],
                               [{"name": "editor", "input": {"path": str(report), "new_text": "# Failure\nFAILED mesh\n"}},
                                "Report complete " + SECRET])
        result = json.loads(child.stdout)
        self.assertEqual(report.read_text(), "# Failure\nFAILED mesh\n")
        self.assertIn(str(report), [item["path"] for item in result["artifacts"]])
        self.assertIn("[REDACTED]", transcript.read_text())
        self.assertNotIn(SECRET, transcript.read_text())

    def test_edits_and_commands_are_denied(self):
        target = self.workspace / "forbidden.txt"
        for tool in [{"name": "editor", "input": {"path": str(target), "new_text": "unsafe"}},
                     {"name": "run_commands", "input": {"commands": ["echo unsafe > forbidden.txt"]}}]:
            with self.subTest(tool=tool["name"]):
                child, _ = self.invoke(["--prompt", "Do work", "--json"], [tool, "Done"], expected=3)
                self.assertEqual(json.loads(child.stdout)["status"], "needs_input")
                self.assertFalse(target.exists())

    def test_mcp_discovery_cannot_launch_without_approval(self):
        marker = self.workspace / "launched.txt"
        config = self.workspace / "mcp.json"
        config.write_text(json.dumps({"mcpServers": {"fixture": {"command": str(self.runtime),
                          "args": ["-e", f"await Bun.write({json.dumps(str(marker))}, 'launched')"]}}}))
        child, requests = self.invoke(["--prompt", "Use MCP", "--mcp-config", str(config), "--json"], ["Done"], expected=3)
        self.assertEqual(json.loads(child.stdout)["status"], "needs_input")
        self.assertFalse(marker.exists())
        self.assertEqual(requests, [])

    def test_authorized_shell_command_returns_real_evidence(self):
        child, requests = self.invoke(["--prompt", "Run a command", "--allow-tools", "--json"],
                                      [{"name": "run_commands", "input": {"commands": ["echo cli-command-evidence"]}},
                                       "Command completed"])
        tool_results = [message for message in requests[1]["messages"] if message["role"] == "tool"]
        self.assertIn("cli-command-evidence", json.dumps(tool_results))
        self.assertEqual(json.loads(child.stdout)["status"], "succeeded")

    def test_stdin_size_limit_and_empty_input(self):
        child, requests = self.invoke(["--stdin", "--json"], ["Unused"], expected=2, stdin="")
        self.assertEqual(json.loads(child.stdout)["error"]["code"], "missing_prompt")
        self.assertEqual(requests, [])
        child, requests = self.invoke(["--stdin", "--json"], ["Unused"], expected=2, stdin="x" * (8 * 1024 * 1024 + 1))
        self.assertEqual(json.loads(child.stdout)["error"]["code"], "input_too_large")
        self.assertEqual(requests, [])

    def test_schema_repair_and_unrecoverable_output(self):
        for repaired, code in [(json.dumps(RESULT), 0), ('{"judgement":"maybe"}', 4)]:
            with self.subTest(code=code):
                child, requests = self.invoke(["--prompt", "Judge", "--json", "--output-schema", str(self.schema),
                                                "--allow-tools"], ["not JSON", repaired], expected=code)
                self.assertEqual(len(requests), 2)
                self.assertFalse(requests[1].get("tools"))
                self.assertEqual(json.loads(child.stdout)["exitCode"], code)

    def test_stream_redacts_credentials_across_chunks(self):
        child, _ = self.invoke(["--prompt", "Summarize", "--stream"], ["Evidence " + SECRET + " end"])
        events = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertEqual(events[-1]["type"], "result")
        self.assertEqual(sum(event["type"] == "result" for event in events), 1)
        self.assertIn("[REDACTED]", "".join(event.get("text", "") for event in events))

    def test_timeout_and_authentication_failure(self):
        child, _ = self.invoke(["--prompt", "Wait", "--json", "--timeout", "1"], ["HANG"], expected=124)
        self.assertEqual(json.loads(child.stdout)["error"]["code"], "timeout")
        child, _ = self.invoke(["--prompt", "Wait", "--json"], [{"http_error": 401}], expected=1)
        self.assertEqual(json.loads(child.stdout)["status"], "failed")

    def test_invalid_inputs_fail_before_gateway_requests(self):
        binary = self.workspace / "binary.dat"
        binary.write_bytes(b"a\x00b")
        bad_schema = self.workspace / "invalid.json"
        bad_schema.write_text('{"$schema":42}')
        for flags in [["--file", "missing.log"], ["--file", str(binary)], ["--cwd", "missing-dir"],
                      ["--output-schema", str(bad_schema)], ["--model", "not-a-model"]]:
            with self.subTest(flags=flags):
                child, requests = self.invoke(["--prompt", "Analyse", "--json"] + flags, ["Unused"], expected=2)
                self.assertEqual(json.loads(child.stdout)["status"], "failed")
                self.assertEqual(requests, [])

    def test_parallel_processes_have_independent_sessions(self):
        def one(index):
            marker = f"isolated-{index}"
            child, requests = self.invoke(["--prompt", marker, "--json"], [marker])
            return marker, json.loads(child.stdout)["result"], requests
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            results = list(pool.map(one, range(3)))
        for marker, result, requests in results:
            self.assertEqual(result, marker)
            self.assertIn(marker, json.dumps(requests))
            for other, _, _ in results:
                if other != marker:
                    self.assertNotIn(other, json.dumps(requests))

    @unittest.skipIf(os.name == "nt", "POSIX PTY test; Windows chat is checked manually")
    def test_interactive_multiline_history_and_cancellation(self):
        import pty
        import select
        import signal
        master, slave = pty.openpty()
        child = None
        received = b""

        def until(text):
            nonlocal received
            deadline = time.monotonic() + 30
            while text not in received:
                if time.monotonic() >= deadline:
                    self.fail(f"PTY timed out waiting for {text!r}: {received!r}")
                if select.select([master], [], [], 0.2)[0]:
                    received += os.read(master, 65536)
            received = received.split(text, 1)[1]

        try:
            with gateway(["Ready", "ORBIT", "HANG"]) as (url, requests):
                child = subprocess.Popen(self.command + ["chat", "--cwd", str(self.workspace)],
                                         env={**self.env, "PLINY_BASE_URL": url}, stdin=slave, stdout=slave, stderr=slave,
                                         start_new_session=True)
                os.close(slave)
                slave = -1
                until(b"You> ")
                os.write(master, b"Remember ORBIT\\\nReply Ready\n")
                until(b"Ready")
                until(b"You> ")
                os.write(master, b"What marker?\n")
                until(b"ORBIT")
                until(b"You> ")
                self.assertIn("Remember ORBIT\\nReply Ready", json.dumps(requests[0]))
                self.assertIn("Remember ORBIT", json.dumps(requests[1]))
                os.write(master, b"Wait forever\n")
                deadline = time.monotonic() + 20
                while len(requests) < 3 and time.monotonic() < deadline:
                    time.sleep(0.05)
                self.assertEqual(len(requests), 3)
                child.send_signal(signal.SIGINT)
                self.assertEqual(child.wait(timeout=15), 130)
        finally:
            if child and child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            os.close(master)
            if slave >= 0:
                os.close(slave)


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]] + TEST_ARGS, verbosity=2)
