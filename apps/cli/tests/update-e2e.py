"""Updater acceptance against native packages, with a compile-time loopback baseline.
Production bundles have no runtime feed override. Requires only Python stdlib.
"""
import argparse
import hashlib
import http.server
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import threading
import time
import unittest
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument("--package", required=True, type=Path)
parser.add_argument("--fixture", required=True, type=Path)
args, rest = parser.parse_known_args()
PACKAGE = args.package.resolve()
FIXTURE = args.fixture.resolve()
PLATFORM = "windows" if os.name == "nt" else "linux"
VERSION = json.loads((PACKAGE / "cli-package.json").read_text())["version"]
NAME = f"PlinyCode-CLI-{VERSION}-{PLATFORM}-x64." + ("zip" if os.name == "nt" else "tar.gz")
PREFIX = f"plinycode-{PLATFORM}-x64"
BASE = "http://127.0.0.1:47835"


def checksum_files(folder):
    entries = []
    for path in sorted(folder.rglob("*")):
        if path.is_file() and path.name != "SHA256SUMS":
            entries.append(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.relative_to(folder).as_posix()}")
    (folder / "SHA256SUMS").write_text("\n".join(entries) + "\n")


def archive_files(files):
    output = io.BytesIO()
    if os.name == "nt":
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, data in files.items():
                archive.writestr(name, data)
    else:
        with tarfile.open(fileobj=output, mode="w:gz") as archive:
            for name, data in files.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                entry.mode = 0o755 if name.endswith(("/bun", "/plinycode")) else 0o644
                archive.addfile(entry, io.BytesIO(data))
    return output.getvalue()


class UpdateAcceptance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.files = {f"{PREFIX}/{p.relative_to(PACKAGE).as_posix()}": p.read_bytes()
                     for p in PACKAGE.rglob("*") if p.is_file()}
        cls.archive = archive_files(cls.files)
        cls.mode = "good"
        cls.started = threading.Event()
        cls.release_download = threading.Event()
        cls.requests = []
        cls.model_started = threading.Event()
        cls.model_release = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                cls.model_started.set()
                cls.model_release.wait(30)
                data = {"id": "fixture", "object": "chat.completion.chunk", "model": "snps-provider-vmodels/glm-5.3",
                        "choices": [{"index": 0, "delta": {"content": "Original task finished"}, "finish_reason": None}]}
                done = dict(data, choices=[{"index": 0, "delta": {}, "finish_reason": "stop"}],
                            usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                try:
                    self.wfile.write(("data: " + json.dumps(data) + "\n\ndata: " + json.dumps(done) + "\n\ndata: [DONE]\n\n").encode())
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

            def do_GET(self):
                cls.requests.append(self.path)
                release = {"tag_name": f"cli-v{VERSION}", "draft": False, "prerelease": False,
                           "assets": [{"name": n, "browser_download_url": BASE + "/" + n}
                                      for n in [NAME, "SHA256SUMS"]]}
                payload = cls.archive
                if cls.mode == "malformed":
                    payload = b"not-an-archive"
                elif cls.mode == "traversal":
                    payload = archive_files({"../escaped.txt": b"unsafe"})
                elif cls.mode in ("startup", "metadata", "tampered"):
                    files = dict(cls.files)
                    if cls.mode == "startup":
                        files[f"{PREFIX}/plinycode.js"] = b"process.exit(17);"
                    elif cls.mode == "metadata":
                        files[f"{PREFIX}/cli-package.json"] = b'{"version":"0.1.1"}'
                    else:
                        files[f"{PREFIX}/plinycode.js"] += b"\n// tampered"
                    if cls.mode != "tampered":
                        manifest = "\n".join(f"{hashlib.sha256(data).hexdigest()}  {name[len(PREFIX)+1:]}"
                                             for name, data in files.items() if not name.endswith("/SHA256SUMS"))
                        files[f"{PREFIX}/SHA256SUMS"] = manifest.encode() + b"\n"
                    payload = archive_files(files)
                if cls.mode == "http":
                    self.send_error(503)
                    return
                if self.path.startswith("/releases/tags/"):
                    data = json.dumps(release).encode()
                elif self.path.startswith("/releases?"):
                    data = json.dumps([dict(release, tag_name="desktop-v99.0.0"),
                                       dict(release, tag_name="cli-v99.0.0", prerelease=True), release]).encode()
                elif self.path == "/SHA256SUMS":
                    digest = "0" * 64 if cls.mode == "checksum" else hashlib.sha256(payload).hexdigest()
                    data = f"{digest}  {NAME}\n".encode()
                elif self.path == "/" + NAME:
                    data = payload
                    if cls.mode == "slow":
                        cls.started.set()
                        cls.release_download.wait(30)
                    if cls.mode == "interrupt":
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data[:1024])
                        self.close_connection = True
                        return
                else:
                    self.send_error(404)
                    return
                try:
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 47835), Handler)
        cls.server.daemon_threads = True
        cls.worker = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.worker.start()

    @classmethod
    def tearDownClass(cls):
        cls.release_download.set()
        cls.server.shutdown()
        cls.server.server_close()
        cls.worker.join(5)

    def setUp(self):
        type(self).mode = "good"
        self.started.clear()
        self.model_started.clear()
        self.model_release.clear()
        self.release_download.clear()
        self.temp = tempfile.TemporaryDirectory(prefix="PlinyCode update test ")
        self.root = Path(self.temp.name) / "CLI with spaces Ω"
        shutil.copytree(PACKAGE, self.root)
        shutil.copyfile(FIXTURE, self.root / "plinycode.js")
        info = json.loads((self.root / "cli-package.json").read_text())
        info["version"] = "0.0.0"
        (self.root / "cli-package.json").write_text(json.dumps(info))
        checksum_files(self.root)
        self.env = dict(os.environ, PLINYCODE_UPDATE_NOTIFY="1")
        self.env.pop("PLINY_API_KEY", None)
        self.env.pop("PLINYCODE_INSTALL_ROOT", None)

    def tearDown(self):
        self.release_download.set()
        self.temp.cleanup()

    def command(self, *args):
        launcher = self.root / ("plinycode.cmd" if os.name == "nt" else "plinycode")
        if os.name == "nt":
            # cmd /s requires an outer quoted command when both the executable and an argument have spaces.
            return '"' + os.environ.get("COMSPEC", "cmd.exe") + '" /d /s /c "' + subprocess.list2cmdline([str(launcher)] + list(args)) + '"'
        return [str(launcher)] + list(args)

    def run_cli(self, *args, ok=True):
        result = subprocess.run(self.command(*args), cwd=self.temp.name, env=self.env,
                                capture_output=True, text=True, encoding="utf-8", timeout=120)
        if ok:
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        else:
            self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    def unchanged(self):
        self.assertEqual(self.run_cli("--version").stdout.strip(), "0.0.0")
        self.assertFalse((self.root / "update-state.json").exists())
        self.assertFalse((self.root / ".update-lock").exists())
        self.assertEqual(list(self.root.glob(".update-stage-*")), [])

    def test_check_is_read_only_and_filters_other_products(self):
        result = json.loads(self.run_cli("update", "--check", "--json").stdout)
        self.assertEqual(result, {"current": "0.0.0", "latest": VERSION, "available": True})
        self.unchanged()

    def test_success_rollback_and_explicit_version_preserve_user_files(self):
        (self.root / "my-skills").mkdir()
        sentinel = self.root / "my-skills" / "SKILL.md"
        sentinel.write_text("keep my skill")
        self.run_cli("update", "--json")
        self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)
        # Production candidate can rollback offline; no feed override required.
        type(self).mode = "http"
        self.run_cli("update", "--rollback")
        self.assertEqual(self.run_cli("--version").stdout.strip(), "0.0.0")
        type(self).mode = "good"
        self.run_cli("update", "--version", VERSION)
        self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)
        self.assertEqual(sentinel.read_text(), "keep my skill")

    def test_failed_downloads_leave_installation_usable(self):
        for mode in ["http", "checksum", "interrupt", "malformed", "traversal", "metadata", "tampered", "startup"]:
            with self.subTest(mode=mode):
                type(self).mode = mode
                self.run_cli("update", "--json", ok=False)
                self.unchanged()
                self.assertFalse((Path(self.temp.name) / "escaped.txt").exists())

    def test_parallel_update_is_rejected(self):
        type(self).mode = "slow"
        child = subprocess.Popen(self.command("update"), env=self.env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(self.started.wait(20))
            second = self.run_cli("update", ok=False)
            self.assertIn("Another CLI update", second.stderr)
            self.release_download.set()
            output, errors = child.communicate(timeout=120)
            self.assertEqual(child.returncode, 0, (output, errors))
            self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)
        finally:
            self.release_download.set()
            if child.poll() is None:
                child.kill()
                child.wait(10)

    def test_running_pipeline_finishes_across_update(self):
        child = subprocess.Popen(self.command("run", "--prompt", "Wait for the result", "--model",
                                             "snps-provider-vmodels/glm-5.3", "--json"), cwd=self.temp.name,
                                 env=dict(self.env, PLINY_API_KEY="updater-fixture-key", PLINY_BASE_URL=BASE + "/api/llm"),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            if not self.model_started.wait(20):
                if child.poll() is None:
                    child.kill()
                output, errors = child.communicate(timeout=10)
                self.fail(f"Pipeline did not reach fixture: {output!r} {errors!r}")
            self.run_cli("update")
            self.assertIsNone(child.poll(), "Running task was interrupted by update")
            self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)
            self.model_release.set()
            output, errors = child.communicate(timeout=20)
            self.assertEqual(child.returncode, 0, (output, errors))
            self.assertEqual(json.loads(output)["result"], "Original task finished")
        finally:
            self.model_release.set()
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)

    def test_killed_updater_recovers_on_next_attempt(self):
        type(self).mode = "slow"
        runtime = self.root / "runtime" / ("bun.exe" if os.name == "nt" else "bun")
        child = subprocess.Popen([str(runtime), str(self.root / "plinycode.js"), "update"],
                                 env=dict(self.env, PLINYCODE_INSTALL_ROOT=str(self.root)),
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            self.assertTrue(self.started.wait(20))
            child.kill()
            child.communicate(timeout=10)
            self.assertEqual(self.run_cli("--version").stdout.strip(), "0.0.0")
            self.release_download.set()
            type(self).mode = "good"
            self.run_cli("update")
            self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)
        finally:
            self.release_download.set()
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=10)

    def test_stale_lock_recovers_after_interrupted_updater(self):
        lock = self.root / ".update-lock"
        lock.mkdir()
        (lock / "owner.json").write_text(json.dumps({"pid": 2147483647}))
        self.run_cli("update")
        self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)

    def test_rollback_rejects_missing_or_corrupt_previous_version(self):
        self.run_cli("update", "--rollback", ok=False)
        self.unchanged()
        self.run_cli("update")
        with (self.root / "plinycode.js").open("a") as file:
            file.write("\n// corrupt previous version")
        self.run_cli("update", "--rollback", ok=False)
        self.assertEqual(self.run_cli("--version").stdout.strip(), VERSION)

    def test_failed_activation_keeps_original_version(self):
        state = self.root / "update-state.json"
        state.write_text('{"current":"."}')
        if os.name == "nt":
            state.chmod(0o444)
        else:
            self.root.chmod(0o555)
        try:
            self.run_cli("update", ok=False)
            self.assertEqual(self.run_cli("--version").stdout.strip(), "0.0.0")
        finally:
            state.chmod(0o644)
            self.root.chmod(0o755)

    @unittest.skipIf(os.name == "nt", "Uses POSIX PTY")
    def test_chat_notification_is_opt_in_and_cached(self):
        import pty
        import select
        def chat(notify):
            master, slave = pty.openpty()
            child = subprocess.Popen(self.command("chat"), cwd=self.temp.name,
                                     env=dict(self.env, PLINY_API_KEY="updater-fixture-key", PLINYCODE_UPDATE_NOTIFY=notify),
                                     stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
            os.close(slave)
            received = b""
            try:
                deadline = time.monotonic() + 25
                while b"You> " not in received:
                    if time.monotonic() > deadline:
                        self.fail(f"Chat did not start: {received!r}")
                    if select.select([master], [], [], 0.2)[0]:
                        received += os.read(master, 65536)
                # Give the asynchronous cached check time to finish without submitting a model prompt.
                until = time.monotonic() + 1
                while time.monotonic() < until:
                    if select.select([master], [], [], 0.1)[0]:
                        received += os.read(master, 65536)
                os.write(master, b"/exit\n")
                self.assertEqual(child.wait(timeout=10), 0, received)
                return received
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(10)
                os.close(master)
        before = len(self.requests)
        chat("0")
        self.assertEqual(len(self.requests), before)
        self.assertIn(f"CLI {VERSION} is available".encode(), chat("1"))
        after = len(self.requests)
        self.assertGreater(after, before)
        chat("1")
        self.assertEqual(len(self.requests), after)

    def test_no_update_checks_for_noninteractive_commands(self):
        before = len(self.requests)
        self.run_cli("--version")
        self.run_cli("--help")
        self.run_cli("skills", "--json")
        self.assertEqual(len(self.requests), before)


if __name__ == "__main__":
    unittest.main(argv=[__file__] + rest, verbosity=2)
