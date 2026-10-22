"""Tests for the Frontier plugin helper (plugin/skills/frontier/scripts/frontier.py).

Standard library only: temp folders plus a local http.server fake of the ticket endpoints and the
presigned PUT/GET links, served over http on 127.0.0.1 (the helper accepts plain http only for a
loopback --base, which production use never passes).

Run: python3 -m unittest discover -s tests/plugin
"""
from __future__ import annotations

import contextlib
import errno
import stat
import hashlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unicodedata
import unittest
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
SCRIPT = HERE.parent.parent / "plugin" / "skills" / "frontier" / "scripts" / "frontier.py"

_spec = importlib.util.spec_from_file_location("frontier_helper", SCRIPT)
fr = importlib.util.module_from_spec(_spec)
sys.modules["frontier_helper"] = fr
_spec.loader.exec_module(fr)  # type: ignore[union-attr]

RAW = "A" * 20 + "b-c_d" + "9" * 18  # 43 characters, like a real ticket
TASK = "task-1234abcd5678"
DEST = "Q3 report"

# The shared folder-relative path vectors (same lists as the server's relpath tests).
MAX_RELPATH = 512
MAX_SEGMENT_BYTES = 255
GOOD = ["2025/W-2s/acme.pdf", "a b/c.pdf", "a.pdf", "x/y/z/notes.md", ".hidden/a.pdf", "a..b/c",
        "console.pdf", "CONFIG/a.pdf", "com10.txt", "lpt0.txt", "x/.frontier/a.pdf", "日本/報告.pdf",
        "é" * 127 + "/a.pdf"]
BAD = [
    "/etc/x", "a/../b", "./a", "C:/x", "c:x", "a//b", "a\\b", "", "a/", "..", ".", "a/.",
    "x" * (MAX_RELPATH + 1),
    "x\u0000", "a/\u001fb", "a\u007f", "a\u0085b", "inv\u202eoice.pdf", "a\u200bb.pdf", "a\u200d.pdf",
    "\ufeffa.pdf", "a\u2028- `fake.pdf`", "a\u2029b",
    "日" * 86 + ".pdf", "a/" + "b" * (MAX_SEGMENT_BYTES + 1),
    "a./b.pdf", "a /b.pdf", "report.pdf.", "report.pdf ", "CON", "con.pdf", "Nul.tar.gz", "x/aux.txt",
    "COM1", "lpt9.log", "prn .txt",
    ".frontier/a.pdf", ".FRONTIER/x",
]


class Fake:
    """Shared state of the fake server."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.requests: list[tuple[str, str, dict]] = []  # (method, path, headers)
        self.manifests: list[dict] = []
        self.puts: dict[str, tuple[bytes, dict]] = {}
        self.put_fail: dict[str, int] = {}  # path -> number of 500s before success
        self.put_status: dict[str, int] = {}  # path -> fixed status
        self.multipart: dict[str, list[int]] = {}  # path -> part sizes the fake server plans
        self.rejected: list[dict] = []  # manifests answered 400 for "multipart"
        self.completes: list[dict] = []  # bodies POSTed to /v1/connect/t/complete
        self.complete_fail: set[str] = set()
        self.complete_raw: object = None  # when set, /complete answers with this
        self.skip_names: set[str] = set()
        self.manifest_status = 200
        self.reject_multipart = False  # a pre-multipart backend: 400 on the unknown field
        self.extra_uploads: list[dict] = []
        self.put_url_override: dict[str, str] = {}
        self.download: dict = {}
        self.blobs: dict[str, bytes] = {}
        self.blob_mode: dict[str, str] = {}  # name -> "short" | "redirect" | "500"
        self.base = ""
        self.acks: list[dict] = []  # bodies POSTed to /v1/connect/t/saved
        self.ack_status = 200


def make_handler(fake: Fake):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _send(self, code: int, body: bytes = b"", ctype: str = "application/json",
                  extra: dict | None = None) -> None:
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if body:
                self.wfile.write(body)

        def _json(self, code: int, obj) -> None:
            self._send(code, json.dumps(obj).encode())

        def _body(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def _authed(self) -> bool:
            return self.headers.get("Authorization") == f"Ticket {RAW}"

        def _record(self) -> None:
            with fake.lock:
                fake.requests.append((self.command, self.path, dict(self.headers.items())))

        def do_POST(self):
            self._record()
            body = self._body()
            if self.path == "/v1/connect/t/saved" and self._authed():
                with fake.lock:
                    fake.acks.append(json.loads(body))
                if fake.ack_status != 200:
                    return self._json(fake.ack_status, {"detail": "nope"})
                return self._json(200, {"ok": True})
            if self.path == "/v1/connect/t/complete" and self._authed():
                b = json.loads(body)
                with fake.lock:
                    fake.completes.append(b)
                if fake.complete_raw is not None:
                    return self._json(200, fake.complete_raw)
                ok = [p for p in b.get("complete", []) if p not in fake.complete_fail]
                return self._json(200, {"completed": ok, "failed": [
                    {"path": p, "reason": "parts missing or the wrong size"}
                    for p in b.get("complete", []) if p in fake.complete_fail]})
            if self.path != "/v1/connect/t/manifest" or not self._authed():
                return self._json(404, {"detail": "not found"})
            if fake.manifest_status != 200:
                return self._json(fake.manifest_status, {"detail": "nope"})
            m = json.loads(body)
            if fake.reject_multipart and "multipart" in m:
                with fake.lock:
                    fake.rejected.append(m)
                return self._json(400, {"detail": "extra fields not permitted"})
            fake.manifests.append(m)
            uploads, skipped = [], []
            for f in m["files"]:
                name = f["path"].rsplit("/", 1)[-1]
                if name in fake.skip_names:
                    skipped.append({"path": f["path"]})
                    continue
                i = len(uploads)
                if m.get("multipart") and f["path"] in fake.multipart:
                    parts = []
                    for n, size in enumerate(fake.multipart[f["path"]], 1):
                        route = f"/part/{i}/{n}?sig=s3cr3t"
                        parts.append({"n": n, "size": size, "put_url": f"{fake.base}{route}"})
                        with fake.lock:
                            fake.put_route = getattr(fake, "put_route", {})
                            fake.put_route[route] = f"{f['path']}#{n}"
                    uploads.append({"path": f["path"], "parts": parts,
                                    "headers": {"Content-Type": f["mime"]}})
                    continue
                url = fake.put_url_override.get(f["path"], f"{fake.base}/put/{i}?sig=s3cr3t")
                uploads.append({"path": f["path"], "put_url": url,
                                "headers": {"Content-Type": f["mime"]}})
                with fake.lock:
                    fake.put_route = getattr(fake, "put_route", {})
                    fake.put_route[f"/put/{i}?sig=s3cr3t"] = f["path"]
            uploads += fake.extra_uploads
            self._json(200, {"task_id": TASK, "uploads": uploads, "skipped": skipped,
                             "expires_in_s": 600})

        def do_PUT(self):
            self._record()
            body = self._body()
            path = getattr(fake, "put_route", {}).get(self.path)
            if path is None:
                return self._json(404, {})
            if path in fake.put_status:
                return self._json(fake.put_status[path], {})
            with fake.lock:
                left = fake.put_fail.get(path, 0)
                if left:
                    fake.put_fail[path] = left - 1
            if left:
                return self._json(500, {})
            with fake.lock:
                fake.puts[path] = (body, dict(self.headers.items()))
            self._send(200)

        def do_GET(self):
            self._record()
            if self.path == "/v1/connect/t/files":
                if not self._authed():
                    return self._json(404, {"detail": "not found"})
                return self._json(200, fake.download)
            if self.path.startswith("/get/"):
                name = self.path[len("/get/"):].split("?", 1)[0]
                data = fake.blobs.get(name)
                mode = fake.blob_mode.get(name)
                if data is None:
                    return self._json(404, {})
                if mode == "redirect":
                    return self._send(302, extra={"Location": f"{fake.base}/get/other"})
                if mode == "500":
                    return self._json(500, {})
                if mode == "short":  # promise the listed size, send less, then close
                    self.send_response(200)
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data[:-2])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                return self._send(200, data, "application/octet-stream")
            self._json(404, {})

    return H


class Base(unittest.TestCase):
    def setUp(self) -> None:
        self.fake = Fake()
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.fake))
        self.fake.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, args=(0.05,), daemon=True)
        self.thread.start()
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.ticket = f"{self.fake.base}/v1/connect/t#{RAW}"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def run_cli(self, *argv: str, base: bool = True) -> tuple[int, dict | None, str]:
        args = list(argv) + (["--base", self.fake.base] if base else [])
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = fr.main(args)
        text = out.getvalue()
        self.assertNotIn(RAW, text + err.getvalue(), "the ticket secret must never be printed")
        self.assertNotIn("s3cr3t", text + err.getvalue(), "presigned links must never be printed")
        return code, (json.loads(text) if text.strip() else None), err.getvalue()

    def tree(self, files: dict[str, bytes]) -> Path:
        root = self.dir / "src"
        for rel, data in files.items():
            p = root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(data)
        root.mkdir(exist_ok=True)
        return root


class PathRules(unittest.TestCase):
    def test_good_paths_pass_unchanged(self):
        for p in GOOD:
            with self.subTest(p=p):
                self.assertEqual(fr.safe_relpath(p), p)

    def test_bad_paths_raise(self):
        for p in BAD:
            with self.subTest(p=p):
                with self.assertRaises(ValueError):
                    fr.safe_relpath(p)

    def test_nfc_normalized(self):
        decomposed = unicodedata.normalize("NFD", "café/résumé.pdf")
        self.assertNotEqual(decomposed, "café/résumé.pdf")
        self.assertEqual(fr.safe_relpath(decomposed), "café/résumé.pdf")

    def test_length_limits(self):
        self.assertEqual(fr.safe_relpath("a/" * 255 + "b"), "a/" * 255 + "b")
        self.assertEqual(fr.safe_relpath("b" * 255), "b" * 255)

    def test_not_a_string(self):
        with self.assertRaises(ValueError):
            fr.safe_relpath(None)  # type: ignore[arg-type]

    def test_duplicate_key(self):
        self.assertEqual(fr.relpath_key("A.pdf"), fr.relpath_key("a.PDF"))
        self.assertEqual(fr.relpath_key(unicodedata.normalize("NFD", "Café.pdf")),
                         fr.relpath_key("café.pdf"))

    def test_local_segment_replaces_windows_characters(self):
        self.assertEqual(fr.local_segment('a:b*c?d"e<f>g|h.pdf'), "a-b-c-d-e-f-g-h.pdf")
        self.assertEqual(fr.local_segment("plain.pdf"), "plain.pdf")


class Tickets(unittest.TestCase):
    def test_net_hint_names_only_the_api_host(self):
        self.assertEqual(fr.net_hint({"api.parallelfrontier.io"}),
                         "Could not reach Frontier (api.parallelfrontier.io). Check the connection "
                         "and try again.")
        self.assertEqual(fr.net_hint({"files.storage.example"}),
                         "Could not reach Frontier. Check the connection and try again.")

    def test_proxy_refusing_frontier_says_which_setting_to_change(self):
        # PFL-65: the AI app's egress proxy refuses the CONNECT to api.parallelfrontier.io. The
        # helper names the one domain and where to allow it, instead of "check the connection".
        class Refuse(BaseHTTPRequestHandler):
            def do_CONNECT(self):  # noqa: N802
                self.send_response(403, "Forbidden")
                self.end_headers()

            def log_message(self, *a):  # noqa: ANN002
                pass

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), Refuse)
        threading.Thread(target=proxy.serve_forever, daemon=True).start()
        self.addCleanup(proxy.shutdown)
        env = {k: v for k, v in os.environ.items() if k.lower() not in ("https_proxy", "no_proxy")}
        env["HTTPS_PROXY"] = f"http://127.0.0.1:{proxy.server_address[1]}"
        with tempfile.TemporaryDirectory() as root:
            Path(root, "a.pdf").write_bytes(b"1")
            r = subprocess.run([sys.executable, str(SCRIPT), "stage", "--ticket",
                                f"https://api.parallelfrontier.io/v1/connect/t#{RAW}", "--root", root],
                               capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertIn(fr.NETWORK_BLOCKED, r.stderr)
        for want in ("api.parallelfrontier.io", "Settings → Capabilities", "Admin settings → Capabilities"):
            self.assertIn(want, fr.NETWORK_BLOCKED)
        self.assertNotIn("Check the connection", r.stderr)

    def test_plain_network_failure_keeps_the_connection_hint(self):
        err = urllib.error.URLError(ConnectionRefusedError(111, "Connection refused"))
        with mock.patch.object(fr, "_opener") as op:
            op.return_value.open.side_effect = err
            with self.assertRaises(fr.FrontierError) as ctx:
                fr.ticket_call("https://api.parallelfrontier.io", RAW, "GET", "/files", None, False)
        self.assertEqual(str(ctx.exception), fr.net_hint({"api.parallelfrontier.io"}))

    def test_production_ticket_parses(self):
        raw = fr.parse_ticket(f"https://api.parallelfrontier.io/v1/connect/t#{RAW}", None)
        self.assertEqual(raw, ("https://api.parallelfrontier.io", RAW))

    def test_bad_tickets_refused(self):
        bad = [
            f"http://api.parallelfrontier.io/v1/connect/t#{RAW}",
            f"https://api.parallelfrontier.io.evil.example/v1/connect/t#{RAW}",
            f"https://evil.example/v1/connect/t#{RAW}",
            f"https://api.parallelfrontier.io/v1/connect/x#{RAW}",
            f"https://api.parallelfrontier.io/v1/connect/t/manifest#{RAW}",
            f"https://api.parallelfrontier.io/v1/connect/t?x=1#{RAW}",
            "https://api.parallelfrontier.io/v1/connect/t",
            "https://api.parallelfrontier.io/v1/connect/t#",
            "https://api.parallelfrontier.io/v1/connect/t#a b\r\nX: y" + "a" * 40,
            f"https://user@api.parallelfrontier.io/v1/connect/t#{RAW}",
            f"https://api.parallelfrontier.io:8443/v1/connect/t#{RAW}",
        ]
        for t in bad:
            with self.subTest(t=t):
                with self.assertRaises(fr.UsageError):
                    fr.parse_ticket(t, None)

    def test_base_override_is_loopback_only(self):
        for base in ["https://evil.example", "http://example.com", "http://10.0.0.1:80"]:
            with self.subTest(base=base):
                with self.assertRaises(fr.UsageError):
                    fr.parse_ticket(f"{base}/v1/connect/t#{RAW}", base)
        self.assertEqual(fr.parse_ticket(f"http://127.0.0.1:9/v1/connect/t#{RAW}",
                                         "http://127.0.0.1:9"), ("http://127.0.0.1:9", RAW))

    def test_ticket_for_a_different_base_refused(self):
        with self.assertRaises(fr.UsageError):
            fr.parse_ticket(f"https://api.parallelfrontier.io/v1/connect/t#{RAW}", "http://127.0.0.1:9")


class Walk(Base):
    def test_skip_rules(self):
        root = self.tree({
            "a.pdf": b"1", "sub/b.xlsx": b"22", ".hidden.txt": b"h", ".git/config": b"x",
            "sub/.cache/c.txt": b"x", "~$lock.docx": b"x", "sub/.DS_Store": b"x",
            "Thumbs.db": b"x", "sub/deep/c.md": b"333",
        })
        outside = self.dir / "outside.txt"
        outside.write_text("secret")
        try:
            os.symlink(outside, root / "link-out.txt")
            os.symlink(root / "a.pdf", root / "link-in.pdf")
            os.symlink(self.dir, root / "dirlink")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        files = fr.walk(root, [])
        got = {f.rel: (f.size, f.explicit) for f in files}
        self.assertEqual(got, {"a.pdf": (1, False), "sub/b.xlsx": (2, False),
                               "sub/deep/c.md": (3, False), "link-in.pdf": (1, False)})

    def test_symlinked_dir_outside_root_pruned(self):
        root = self.tree({"a.pdf": b"1"})
        outside = self.dir / "outside"
        outside.mkdir()
        (outside / "secret.txt").write_text("s")
        try:
            os.symlink(outside, root / "out")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertEqual([f.rel for f in fr.walk(root, [])], ["a.pdf"])

    def test_dir_whose_realpath_leaves_root_is_pruned(self):
        """A junction or bind mount looks like a plain folder; its realpath gives it away."""
        root = self.tree({"a.pdf": b"1", "mnt/secret.txt": b"s", "ok/b.txt": b"2"})
        outside = str(self.dir / "elsewhere")
        real = os.path.realpath
        mnt = str(root / "mnt")

        def fake_realpath(p, *a, **k):
            p = str(p)
            if p == mnt or p.startswith(mnt + os.sep):
                return outside + p[len(mnt):]
            return real(p, *a, **k)

        with mock.patch.object(fr.os.path, "realpath", fake_realpath):
            self.assertEqual([f.rel for f in fr.walk(root, [])], ["a.pdf", "ok/b.txt"])

    def test_file_whose_realpath_leaves_root_is_never_listed(self):
        root = self.tree({"a.pdf": b"1", "sub/b.txt": b"2"})
        real = os.path.realpath
        target = str(root / "sub" / "b.txt")

        def fake_realpath(p, *a, **k):
            return str(self.dir / "x.txt") if str(p) == target else real(p, *a, **k)

        with mock.patch.object(fr.os.path, "realpath", fake_realpath):
            self.assertEqual([f.rel for f in fr.walk(root, [])], ["a.pdf"])

    def test_junction_dirs_pruned(self):
        root = self.tree({"a.pdf": b"1", "j/secret.txt": b"s"})
        junction = str(root / "j")
        with mock.patch.object(fr.os.path, "isjunction", lambda p: str(p) == junction, create=True):
            self.assertEqual([f.rel for f in fr.walk(root, [])], ["a.pdf"])

    def test_reparse_point_dirs_pruned(self):
        root = self.tree({"a.pdf": b"1", "rp/secret.txt": b"s"})
        target = str(root / "rp")
        real_lstat = os.lstat

        class St:
            def __init__(self, st):
                self._st = st
                self.st_file_attributes = fr.stat.FILE_ATTRIBUTE_REPARSE_POINT

            def __getattr__(self, name):
                return getattr(self._st, name)

        def fake_lstat(p, *a, **k):
            st = real_lstat(p, *a, **k)
            return St(st) if str(p) == target else st

        with mock.patch.object(fr.os, "lstat", fake_lstat):
            self.assertEqual([f.rel for f in fr.walk(root, [])], ["a.pdf"])

    def test_explicit_paths_flagged_and_only_those(self):
        root = self.tree({"a.pdf": b"1", "sub/b.txt": b"2", "sub/c.txt": b"3", "other.txt": b"4",
                          "sub/.hidden": b"h"})
        files = fr.walk(root, [str(root / "a.pdf"), "sub"])
        got = {f.rel: f.explicit for f in files}
        self.assertEqual(got, {"a.pdf": True, "sub/b.txt": True, "sub/c.txt": True})

    def test_explicit_path_outside_root_refused(self):
        root = self.tree({"a.pdf": b"1"})
        (self.dir / "x.txt").write_text("x")
        with self.assertRaises(fr.UsageError):
            fr.walk(root, [str(self.dir / "x.txt")])
        with self.assertRaises(fr.UsageError):
            fr.walk(root, ["../x.txt"])


class Stage(Base):
    def test_stage_posts_manifest_and_uploads(self):
        root = self.tree({"a.pdf": b"%PDF-1", "sub/b.csv": b"x,y\n1,2\n", "sub/c.txt": b"hello",
                          "skip-me.bin": b"zz"})
        self.fake.skip_names = {"skip-me.bin"}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        self.assertEqual(out, {"task_id": TASK, "uploaded": 3, "skipped": 1, "failed": []})
        m = self.fake.manifests[0]["files"]
        by = {f["path"]: f for f in m}
        self.assertEqual(set(by), {"a.pdf", "sub/b.csv", "sub/c.txt", "skip-me.bin"})
        self.assertEqual(by["a.pdf"]["size"], 6)
        self.assertEqual(by["a.pdf"]["mime"], "application/pdf")
        self.assertNotIn("explicit", by["a.pdf"])
        self.assertEqual(self.fake.puts["sub/c.txt"][0], b"hello")
        hdrs = {k.lower(): v for k, v in self.fake.puts["sub/c.txt"][1].items()}
        self.assertEqual(hdrs["content-type"], "text/plain")
        self.assertEqual(hdrs["content-length"], "5")
        self.assertNotIn("authorization", hdrs)
        self.assertIn("3", err)

    def test_ticket_only_in_authorization_header(self):
        root = self.tree({"a.pdf": b"1"})
        self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        for method, path, headers in self.fake.requests:
            self.assertNotIn(RAW, path)
            auth = {k.lower(): v for k, v in headers.items()}.get("authorization")
            if path.startswith("/v1/connect/t"):
                self.assertEqual(auth, f"Ticket {RAW}")
            else:
                self.assertIsNone(auth)

    def test_failed_upload_reported_after_one_retry(self):
        root = self.tree({"a.pdf": b"1", "b.pdf": b"2", "c.pdf": b"3"})
        self.fake.put_fail = {"b.pdf": 2, "c.pdf": 1}  # b fails twice, c recovers on retry
        code, out, _ = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["uploaded"], 2)
        self.assertEqual(out["failed"], ["b.pdf"])
        self.assertIn("c.pdf", self.fake.puts)

    def test_explicit_paths_sent_with_flag(self):
        root = self.tree({"a.pdf": b"1", "b.pdf": b"2"})
        code, out, _ = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root), "b.pdf")
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.manifests[0]["files"],
                         [{"path": "b.pdf", "size": 1, "mime": "application/pdf", "explicit": True}])

    def test_too_many_files(self):
        root = self.dir / "many"
        root.mkdir()
        for i in range(1001):
            (root / f"f{i}.txt").write_bytes(b"")
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 2)
        self.assertIn("subfolder", err)
        self.assertEqual(self.fake.manifests, [])

    def test_unsafe_names_not_sent(self):
        root = self.tree({"ok.txt": b"1", "con.txt": b"2", "end./x.txt": b"3"})
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        self.assertEqual([f["path"] for f in self.fake.manifests[0]["files"]], ["ok.txt"])
        self.assertEqual(sorted(out["not_sent"]), ["con.txt", "end./x.txt"])

    def test_reserved_top_names_not_sent(self):
        root = self.tree({"a.pdf": b"1", "context.md": b"c", "FOLDER-INDEX.md": b"i",
                          "sub/context.md": b"ok", "sub/folder-index.md": b"ok"})
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        self.assertEqual(sorted(f["path"] for f in self.fake.manifests[0]["files"]),
                         ["a.pdf", "sub/context.md", "sub/folder-index.md"])
        self.assertEqual(sorted(out["not_sent"]), ["FOLDER-INDEX.md", "context.md"])
        self.assertIn("context.md", err)
        self.assertIn("folder-index.md", err)

    def test_explicit_reserved_name_refused_too(self):
        root = self.tree({"context.md": b"c", "a.pdf": b"1"})
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root),
                                      "context.md", "a.pdf")
        self.assertEqual(code, 0, err)
        self.assertEqual([f["path"] for f in self.fake.manifests[0]["files"]], ["a.pdf"])

    def test_expired_upload_link_explained(self):
        root = self.tree({"a.pdf": b"1"})
        self.fake.put_status = {"a.pdf": 403}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertIn("expired", err)

    def test_storage_unreachable_says_frontier_and_names_no_host(self):
        root = self.tree({"a.pdf": b"1"})
        self.fake.put_url_override = {"a.pdf": "https://127.0.0.1:1/put?sig=s3cr3t"}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 1)
        self.assertEqual(out["failed"], ["a.pdf"])
        self.assertIn("Could not reach Frontier", err)
        for word in ("127.0.0.1", "allowlist", "allow list", "network settings"):
            self.assertNotIn(word, err)

    def test_explicit_symlinked_folder_inside_root(self):
        root = self.tree({"real/a.txt": b"1"})
        try:
            os.symlink(root / "real", root / "alias")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.assertEqual([f.rel for f in fr.walk(root, ["alias"])], ["alias/a.txt"])

    def test_expired_ticket(self):
        root = self.tree({"a.pdf": b"1"})
        bad = f"{self.fake.base}/v1/connect/t#{'Z' * 43}"
        code, out, err = self.run_cli("stage", "--ticket", bad, "--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("ask", err.lower())
        self.assertNotIn("Z" * 43, err)

    def test_rate_limited(self):
        root = self.tree({"a.pdf": b"1"})
        self.fake.manifest_status = 429
        code, _, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 1)
        self.assertIn("rate", err.lower())

    def test_status_lines_say_what_to_do(self):
        """M-b: a paid lapse is not a retryable blip; access refusals are not either."""
        root = self.tree({"a.pdf": b"1"})
        for status, want, unwanted in (
                (402, "plan is inactive", "try again in a moment"),
                (401, "refused access", "try again in a moment"),
                (403, "refused access", "try again in a moment"),
                (404, "expired", "plan"),
                (409, "HTTP 409", "try again in a moment"),
                (503, "try again in a moment", "plan")):
            self.fake.manifest_status = status
            code, _, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
            self.assertEqual(code, 1, status)
            self.assertIn(want, err, status)
            self.assertNotIn(unwanted, err, status)

    def test_upload_link_must_be_https_or_test_loopback(self):
        root = self.tree({"a.pdf": b"1", "b.pdf": b"2"})
        self.fake.put_url_override = {"a.pdf": "http://example.com/put?sig=s3cr3t"}
        code, out, _ = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["a.pdf"])

    def test_upload_for_unknown_path_refused(self):
        root = self.tree({"a.pdf": b"1"})
        self.fake.extra_uploads = [{"path": "../etc/passwd", "put_url": f"{self.fake.base}/put/9",
                                    "headers": {}}]
        code, out, _ = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["uploaded"], 1)
        self.assertEqual(out["failed"], ["../etc/passwd"])


class Multipart(Base):
    DATA = b"0123456789"

    def test_slices_upload_then_complete(self):
        root = self.tree({"big.bin": self.DATA, "a.pdf": b"1"})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        self.assertIs(self.fake.manifests[0]["multipart"], True)
        self.assertEqual([self.fake.puts[f"big.bin#{n}"][0] for n in (1, 2, 3)], [b"0123", b"4567", b"89"])
        self.assertEqual(self.fake.puts["big.bin#3"][1]["Content-Length"], "2")
        self.assertEqual(self.fake.completes, [{"complete": ["big.bin"], "abort": []}])
        self.assertEqual(out["uploaded"], 2)
        self.assertEqual(out["failed"], [])

    def test_a_failed_part_aborts_the_file(self):
        root = self.tree({"big.bin": self.DATA})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        self.fake.put_status = {"big.bin#2": 403}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertEqual(self.fake.completes, [{"complete": [], "abort": ["big.bin"]}])
        self.assertIn("expired", err)

    def test_parts_that_do_not_add_up_are_never_sent(self):
        root = self.tree({"big.bin": self.DATA})
        self.fake.multipart = {"big.bin": [4, 4]}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertFalse([p for m, p, _ in self.fake.requests if p.startswith("/part/")])
        # The upload is open server-side: an unusable plan is aborted, not just reported.
        self.assertEqual(self.fake.completes, [{"complete": [], "abort": ["big.bin"]}])

    def test_frontier_refusing_to_finish_fails_the_file(self):
        root = self.tree({"big.bin": self.DATA})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        self.fake.complete_fail = {"big.bin"}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertIn("Could not upload big.bin: parts missing or the wrong size", err)

    def test_malformed_complete_answer_fails_the_file_without_a_traceback(self):
        for raw in ({"completed": "big.bin", "failed": {"x": 1}}, [1, 2], {"completed": 7, "failed": True},
                    {"completed": [1, None], "failed": [3, {"path": 5}]}):
            with self.subTest(raw=raw):
                self.fake.completes.clear()
                root = self.tree({"big.bin": self.DATA})
                self.fake.multipart = {"big.bin": [4, 4, 2]}
                self.fake.complete_raw = raw
                code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
                self.assertEqual(code, 3, err)
                self.assertEqual(out["failed"], ["big.bin"])
                self.assertNotIn("Traceback", err)
                self.assertIn("Could not upload big.bin", err)

    def test_a_bad_parts_plan_never_falls_back_to_put_url(self):
        root = self.tree({"big.bin": self.DATA})
        self.fake.extra_uploads = [{"path": "big.bin", "put_url": f"{self.fake.base}/put/9",
                                    "parts": [{"n": True, "size": 10, "put_url": f"{self.fake.base}/part/9"}],
                                    "headers": {}}]
        self.fake.skip_names = {"big.bin"}
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertFalse([p for m, p, _ in self.fake.requests if p.startswith(("/put/", "/part/"))])

    def test_a_400_on_multipart_retries_the_manifest_once_without_it(self):
        root = self.tree({"big.bin": self.DATA, "a.pdf": b"1"})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        self.fake.reject_multipart = True
        code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        self.assertEqual(len(self.fake.rejected), 1)
        self.assertNotIn("multipart", self.fake.manifests[0])
        self.assertEqual(len(self.fake.manifests), 1)
        self.assertEqual(out["uploaded"], 2)
        self.assertEqual(self.fake.puts["big.bin"][0], self.DATA)  # a single put_url

    def test_only_a_400_is_retried_and_only_once(self):
        root = self.tree({"a.pdf": b"1"})
        for status in (400, 403, 429, 500):
            with self.subTest(status=status):
                self.fake.manifest_status = status
                before = len([1 for _m, p, _h in self.fake.requests if p.endswith("/manifest")])
                code, _out, _err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
                self.assertEqual(code, 1)
                after = len([1 for _m, p, _h in self.fake.requests if p.endswith("/manifest")])
                self.assertEqual(after - before, 2 if status == 400 else 1)

    def test_one_failed_part_stops_the_files_remaining_parts(self):
        root = self.tree({"big.bin": self.DATA})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        self.fake.put_status = {"big.bin#1": 403}
        with mock.patch.object(fr, "WORKERS", 1):
            code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        sent = [p for m, p, _ in self.fake.requests if m == "PUT"]
        self.assertEqual(len(sent), 1, sent)  # parts 2 and 3 were never PUT
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertIn("Could not upload big.bin: the link expired", err)
        self.assertEqual(self.fake.completes, [{"complete": [], "abort": ["big.bin"]}])

    def test_a_failed_file_does_not_stop_the_other_files(self):
        root = self.tree({"big.bin": self.DATA, "other.bin": self.DATA})
        self.fake.multipart = {"big.bin": [4, 4, 2], "other.bin": [4, 4, 2]}
        self.fake.put_status = {"big.bin#1": 403}
        with mock.patch.object(fr, "WORKERS", 1):
            code, out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["big.bin"])
        self.assertEqual([self.fake.puts[f"other.bin#{n}"][0] for n in (1, 2, 3)], [b"0123", b"4567", b"89"])

    def test_the_codex_manifest_version_matches_the_user_agent_too(self):
        manifest = json.loads((HERE.parent.parent / "plugin" / ".codex-plugin" / "plugin.json").read_text())
        self.assertEqual(fr.USER_AGENT, f"frontier-plugin/{manifest['version']}")

    def test_user_agent_matches_the_plugin_version(self):
        manifest = json.loads((HERE.parent.parent / "plugin" / ".claude-plugin" / "plugin.json").read_text())
        self.assertEqual(fr.USER_AGENT, f"frontier-plugin/{manifest['version']}")

    def test_every_request_sends_the_helper_user_agent(self):
        root = self.tree({"big.bin": self.DATA, "a.pdf": b"1"})
        self.fake.multipart = {"big.bin": [4, 4, 2]}
        code, _out, err = self.run_cli("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(code, 0, err)
        agents = {h.get("User-Agent") for _m, _p, h in self.fake.requests}
        self.assertEqual(agents, {fr.USER_AGENT})


class Fetch(Base):
    def setUp(self) -> None:
        super().setUp()
        self.to = self.dir / "dest"
        self.to.mkdir()

    def offer(self, files: dict[str, bytes], suggested: str = "Q3 report", task_id: str = TASK,
              **extra) -> None:
        self.fake.blobs = {}
        listed = []
        for i, (path, data) in enumerate(files.items()):
            self.fake.blobs[str(i)] = data
            listed.append({"path": path, "size": len(data),
                           "url": f"{self.fake.base}/get/{i}?sig=s3cr3t"})
        self.fake.download = {"task_id": task_id, "folder": None, "suggested_dir": suggested,
                              "files": listed, "expires_in_s": 600, **extra}

    def fetch(self, to: Path | None = None):
        return self.run_cli("fetch", "--ticket", self.ticket, "--to", str(to or self.to))

    def files(self, root: Path | None = None) -> list[str]:
        """Every file under root except our markers, as sorted relative paths."""
        root = root or self.to
        return sorted(p.relative_to(root).as_posix() for p in root.rglob("*")
                      if p.is_file() and p.name != fr.MARKER)

    def marker(self, folder: Path) -> dict:
        return json.loads((folder / fr.MARKER).read_text())

    def test_recreates_nested_tree(self):
        self.offer({"out/memo.docx": b"memo", "out/data/x.csv": b"1,2", "top.md": b"# hi"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        dest = self.to / DEST
        self.assertEqual(out, {"saved_to": str(dest), "files": 3, "added": 3, "updated": 0,
                               "unchanged": 0, "kept_both": [], "failed": []})
        self.assertEqual((dest / "out/memo.docx").read_bytes(), b"memo")
        self.assertEqual((dest / "out/data/x.csv").read_bytes(), b"1,2")
        self.assertEqual((dest / "top.md").read_bytes(), b"# hi")
        self.assertIn(f"Saved to {dest}: 3 added", err)
        m = self.marker(dest)
        self.assertEqual((m["version"], m["task_id"]), (1, TASK))
        self.assertEqual(m["files"]["out/memo.docx"],
                         {"sha256": hashlib.sha256(b"memo").hexdigest(), "size": 4})
        self.assertEqual(sorted(m["files"]), ["out/data/x.csv", "out/memo.docx", "top.md"])

    def test_same_title_different_tasks_get_separate_marked_folders(self):
        self.offer({"memo.docx": b"one"})
        self.fetch()
        self.offer({"memo.docx": b"two"}, task_id="task-99998888aaaa")
        code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(self.marker(self.to / "Q3 report")["task_id"], TASK)
        self.assertEqual(self.marker(self.to / "Q3 report (2)")["task_id"], "task-99998888aaaa")
        self.assertEqual((self.to / "Q3 report" / "memo.docx").read_bytes(), b"one")
        self.assertEqual((self.to / "Q3 report (2)" / "memo.docx").read_bytes(), b"two")
        # a follow-up of each task goes back to its own folder
        self.offer({"memo.docx": b"one", "extra.txt": b"x"})
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report"))
        self.assertEqual((out["added"], out["unchanged"]), (1, 1))
        self.offer({"memo.docx": b"two"}, task_id="task-99998888aaaa")
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(out["unchanged"], 1)

    def test_non_empty_unmarked_folder_never_adopted(self):
        (self.to / "Q3 report").mkdir()
        (self.to / "Q3 report" / "mine.txt").write_bytes(b"mine")
        (self.to / "Q3 report (2)").mkdir()  # empty: may be adopted
        self.offer({"memo.docx": b"m"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(self.files(self.to / "Q3 report"), ["mine.txt"])
        self.assertFalse((self.to / "Q3 report" / fr.MARKER).exists())

    def test_folder_marked_for_another_task_never_adopted_even_if_empty_otherwise(self):
        other = self.to / "Q3 report"
        other.mkdir()
        fr.write_marker(str(other), "task-other", {})
        self.offer({"memo.docx": b"m"})
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(self.marker(other)["task_id"], "task-other")

    def test_corrupt_marker_is_not_ours(self):
        for i, junk in enumerate((b"{not json", b'{"version": 2, "task_id": "x", "files": {}}',
                                  b"\xff\xfe", b"[]")):
            with self.subTest(junk=junk):
                to = self.dir / f"c{i}"
                (to / "Q3 report").mkdir(parents=True)
                (to / "Q3 report" / fr.MARKER).write_bytes(junk)
                self.offer({"memo.docx": b"m"})
                code, out, err = self.fetch(to)
                self.assertEqual(code, 0, err)
                self.assertEqual(out["saved_to"], str(to / "Q3 report (2)"))
                self.assertEqual((to / "Q3 report" / fr.MARKER).read_bytes(), junk)

    def test_untouched_file_updated_in_place(self):
        self.offer({"memo.docx": b"v1", "keep.txt": b"same"})
        self.fetch()
        dest = self.to / DEST
        ino = os.stat(dest / "memo.docx").st_ino
        self.offer({"memo.docx": b"version two", "keep.txt": b"same"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["updated"], out["unchanged"], out["kept_both"]), (1, 1, []))
        self.assertEqual((dest / "memo.docx").read_bytes(), b"version two")
        self.assertEqual(os.stat(dest / "memo.docx").st_ino, ino, "same file, written in place")
        self.assertEqual(self.files(dest), ["keep.txt", "memo.docx"])
        self.assertEqual(self.marker(dest)["files"]["memo.docx"]["sha256"],
                         hashlib.sha256(b"version two").hexdigest())
        self.offer({"memo.docx": b"v3"})  # shorter again: no stale tail
        self.fetch()
        self.assertEqual((dest / "memo.docx").read_bytes(), b"v3")
        self.assertEqual((dest / "keep.txt").read_bytes(), b"same", "files not delivered are kept")

    def test_user_edited_file_kept_both(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        (dest / "memo.docx").write_bytes(b"my edits")
        self.offer({"memo.docx": b"v2"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["files"], out["updated"], out["kept_both"]), (1, 0, ["memo (2).docx"]))
        self.assertEqual((dest / "memo.docx").read_bytes(), b"my edits")
        self.assertEqual((dest / "memo (2).docx").read_bytes(), b"v2")
        self.assertIn("kept", err)
        # the next version updates the copy we saved alongside, not a third file
        self.offer({"memo.docx": b"v3"})
        code, out, _ = self.fetch()
        self.assertEqual(out["kept_both"], ["memo (2).docx"])
        self.assertEqual((dest / "memo (2).docx").read_bytes(), b"v3")
        self.assertFalse((dest / "memo (3).docx").exists())
        self.assertEqual((dest / "memo.docx").read_bytes(), b"my edits")

    def test_unlink_and_rename_denied_in_destination(self):
        """A connected folder may refuse every delete and rename: fetch never needs one there."""
        real = {"unlink": os.unlink, "remove": os.remove, "rename": os.rename,
                "replace": os.replace}
        to = str(self.to)

        def guard(name):
            def call(path, *a, **k):
                if str(path).startswith(to) or any(str(x).startswith(to) for x in a):
                    raise PermissionError(errno.EPERM, "Operation not permitted")
                return real[name](path, *a, **k)
            return call

        patches = [mock.patch.object(fr.os, n, guard(n)) for n in real]
        for pt in patches:
            pt.start()
        try:
            self.offer({"memo.docx": b"memo", "x/y.csv": b"1,2"})
            code, out, err = self.fetch()
            self.assertEqual(code, 0, err)
            self.assertEqual(out["added"], 2)
            self.offer({"memo.docx": b"memo v2", "x/y.csv": b"1,2"})  # in-place update + marker
            code, out, err = self.fetch()
            self.assertEqual(code, 0, err)
            self.assertEqual((out["updated"], out["unchanged"]), (1, 1))
        finally:
            for pt in patches:
                pt.stop()
        self.assertEqual(self.files(), [f"{DEST}/memo.docx", f"{DEST}/x/y.csv"])
        self.assertEqual((self.to / DEST / "memo.docx").read_bytes(), b"memo v2")
        self.assertEqual(self.marker(self.to / DEST)["files"]["memo.docx"]["sha256"],
                         hashlib.sha256(b"memo v2").hexdigest())

    def test_symlink_at_destination_file_never_written_through(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        outside = self.dir / "outside.docx"
        outside.write_bytes(b"v1")  # same bytes as recorded: looks untouched through the link
        (dest / "memo.docx").unlink()
        try:
            os.symlink(outside, dest / "memo.docx")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.offer({"memo.docx": b"v2"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(outside.read_bytes(), b"v1")
        self.assertEqual(out["kept_both"], ["memo (2).docx"])
        self.assertTrue(os.path.islink(dest / "memo.docx"))

    def test_in_place_refuses_a_link_even_if_checks_raced(self):
        target = self.dir / "t.txt"
        target.write_bytes(b"x")
        link = self.dir / "l.txt"
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        tmp = self.dir / "new"
        tmp.write_bytes(b"new")
        with self.assertRaises((fr._NotOurs, fr._Failure, OSError)):
            fr._update_in_place(str(link), str(tmp))
        self.assertEqual(target.read_bytes(), b"x")

    def test_partial_in_place_then_retry_keeps_both(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        real_copy = fr.shutil.copyfileobj

        def half(src, out, *a):
            out.write(src.read(2))
            raise OSError(errno.EIO, "I/O error")

        self.offer({"memo.docx": b"version two"})
        with mock.patch.object(fr.shutil, "copyfileobj", half):
            code, out, err = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(out["partial"], [str(dest / "memo.docx")])
        self.assertIn("partly written", err)
        self.assertTrue(self.marker(dest)["files"]["memo.docx"].get("pending"))
        self.assertIs(fr.shutil.copyfileobj, real_copy)
        code, out, err = self.fetch()  # the cut-off file is kept; the full version alongside
        self.assertEqual(code, 0, err)
        self.assertEqual((out["updated"], out["kept_both"], out["interrupted"]),
                         (0, ["memo (2).docx"], ["memo.docx"]))
        self.assertEqual((dest / "memo.docx").read_bytes(), b"ve")
        self.assertEqual((dest / "memo (2).docx").read_bytes(), b"version two")
        self.assertIn("cut off", err)
        code, out, _ = self.fetch()  # reported once; the cut-off file is the user's now
        self.assertEqual((out["unchanged"], out["kept_both"]), (1, []))  # the (2) copy matches
        self.assertNotIn("interrupted", out)
        self.assertNotIn("memo.docx", self.marker(dest)["files"])

    def test_partial_new_file_then_retry(self):
        def half(src, out, *a):
            out.write(src.read(1))
            raise OSError(errno.EIO, "I/O error")

        self.offer({"a.txt": b"hello"})
        with mock.patch.object(fr.shutil, "copyfileobj", half):
            code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["kept_both"], out["interrupted"]), (["a (2).txt"], ["a.txt"]))
        self.assertEqual((self.to / DEST / "a.txt").read_bytes(), b"h")
        self.assertEqual((self.to / DEST / "a (2).txt").read_bytes(), b"hello")

    def test_hard_linked_file_never_updated_in_place(self):
        self.offer({"memo.txt": b"v1"})
        self.fetch()
        dest = self.to / DEST
        backup = self.dir / "backup.txt"
        try:
            os.link(dest / "memo.txt", backup)
        except (OSError, NotImplementedError):
            self.skipTest("hard links unavailable")
        self.offer({"memo.txt": b"version2"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["updated"], out["kept_both"]), (0, ["memo (2).txt"]))
        self.assertEqual(backup.read_bytes(), b"v1")
        self.assertEqual((dest / "memo.txt").read_bytes(), b"v1")
        self.assertEqual((dest / "memo (2).txt").read_bytes(), b"version2")

    def test_locked_file_saved_alongside(self):
        """Windows: a file open in another app (or read-only) refuses the write open."""
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        target = str(dest / "memo.docx")
        real_open = os.open

        def locked(path, flags, *a, **k):
            if str(path) == target and not flags & os.O_CREAT:
                raise PermissionError(errno.EACCES, "The process cannot access the file")
            return real_open(path, flags, *a, **k)

        self.offer({"memo.docx": b"v2"})
        with mock.patch.object(fr.os, "open", locked):
            code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual(out["kept_both"], ["memo (2).docx"])
        self.assertEqual((dest / "memo.docx").read_bytes(), b"v1")

    class Killed(BaseException):
        """Stands in for SIGKILL: nothing after it runs, no cleanup writes the marker."""

    def _killed_fetch(self, keep: int, after: int = 0):
        """Run a fetch that writes `after` files fully, then dies after writing `keep` bytes of
        the next; the marker writes that would happen after the kill are suppressed."""
        state = {"dead": False, "done": 0}
        real_write = fr.write_marker
        real_copy = fr.shutil.copyfileobj

        def copy(src, out, *a):
            if state["done"] < after:
                state["done"] += 1
                return real_copy(src, out, *a)
            out.write(src.read(keep))
            out.flush()
            state["dead"] = True
            raise self.Killed()

        def write(*a, **k):
            return True if state["dead"] else real_write(*a, **k)

        with mock.patch.object(fr.shutil, "copyfileobj", copy), \
                mock.patch.object(fr, "write_marker", write):
            with self.assertRaises(self.Killed):
                self.fetch()

    def test_kill_mid_update_keeps_the_cut_off_file(self):
        for v1, v2, keep in ((b"short v1", b"a much longer second version", 5),
                             (b"a much longer first version", b"v2 short", 3)):
            with self.subTest(v1=v1):
                self.to = self.dir / f"k{len(v1)}"
                self.to.mkdir()
                self.offer({"memo.docx": v1})
                self.fetch()
                dest = self.to / DEST
                self.offer({"memo.docx": v2})
                self._killed_fetch(keep)
                self.assertEqual((dest / "memo.docx").read_bytes(), v2[:keep])
                self.assertTrue(self.marker(dest)["files"]["memo.docx"].get("pending"),
                                "pending was saved before the write")
                code, out, err = self.fetch()
                self.assertEqual(code, 0, err)
                self.assertEqual((out["updated"], out["kept_both"], out["interrupted"]),
                                 (0, ["memo (2).docx"], ["memo.docx"]))
                self.assertEqual((dest / "memo.docx").read_bytes(), v2[:keep])
                self.assertEqual((dest / "memo (2).docx").read_bytes(), v2)

    def test_pending_with_old_bytes_updates_in_place(self):
        """Killed after the marker was saved but before the file was touched."""
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        files = self.marker(dest)["files"]
        files["memo.docx"] = {"sha256": files["memo.docx"]["sha256"], "size": 2,
                              "pending": {"prev_sha256": files["memo.docx"]["sha256"],
                                          "prev_size": 2}}
        fr.write_marker(str(dest), TASK, files)
        self.offer({"memo.docx": b"version two"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["updated"], out["kept_both"]), (1, []))
        self.assertNotIn("interrupted", out)
        self.assertEqual((dest / "memo.docx").read_bytes(), b"version two")

    def test_pending_with_new_bytes_is_recorded(self):
        """Killed after the file was written but before the marker's last write."""
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        files = self.marker(dest)["files"]
        files["memo.docx"]["pending"] = {"prev_sha256": files["memo.docx"]["sha256"],
                                         "prev_size": 2}
        fr.write_marker(str(dest), TASK, files)
        (dest / "memo.docx").write_bytes(b"version two")
        self.offer({"memo.docx": b"version two"})
        code, out, err = self.fetch()
        self.assertEqual((code, out["unchanged"], out["kept_both"]), (0, 1, []))
        self.assertNotIn("pending", self.marker(dest)["files"]["memo.docx"])

    def test_trimmed_cut_off_csv_is_never_restored(self):
        """Review round 3: an interrupted CSV update, then the user trims the cut-off last row.
        The file is a strict prefix of the new version, yet it is the user's: never touched."""
        v1 = b"id,amount\n1,10\n2,20\n"
        v2 = b"id,amount\n1,10\n2,20\n3,30\n4,40\n"
        self.offer({"data.csv": v1})
        self.fetch()
        dest = self.to / DEST
        self.offer({"data.csv": v2})
        self._killed_fetch(len(v2) - 3)  # cut off inside the last row
        trimmed = v2[:v2.rindex(b"\n4")] + b"\n"  # the user drops the broken last row
        (dest / "data.csv").write_bytes(trimmed)
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["updated"], out["kept_both"], out["interrupted"]),
                         (0, ["data (2).csv"], ["data.csv"]))
        self.assertEqual((dest / "data.csv").read_bytes(), trimmed)
        self.assertEqual((dest / "data (2).csv").read_bytes(), v2)

    def test_kill_after_some_files(self):
        v1 = {f"f{i}.txt": f"version one of {i}".encode() for i in range(4)}
        v2 = {f"f{i}.txt": f"the second version of file {i}".encode() for i in range(4)}
        self.offer(v1)
        self.fetch()
        dest = self.to / DEST
        self.offer(v2)
        self._killed_fetch(6, after=2)  # f0, f1 written; f2 cut off; f3 untouched
        self.assertEqual((dest / "f1.txt").read_bytes(), v2["f1.txt"])
        self.assertEqual((dest / "f3.txt").read_bytes(), v1["f3.txt"])
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["unchanged"], out["updated"], out["kept_both"], out["interrupted"]),
                         (2, 1, ["f2 (2).txt"], ["f2.txt"]))
        for name in ("f0.txt", "f1.txt", "f3.txt"):
            self.assertEqual((dest / name).read_bytes(), v2[name])
        self.assertEqual((dest / "f2 (2).txt").read_bytes(), v2["f2.txt"])
        recorded = self.marker(dest)["files"]
        for name in ("f0.txt", "f1.txt", "f3.txt"):
            self.assertEqual(recorded[name], {"sha256": hashlib.sha256(v2[name]).hexdigest(),
                                              "size": len(v2[name])})
        self.assertNotIn("f2.txt", recorded)

    def test_kill_after_some_new_files(self):
        new = {f"n{i}.txt": f"new file number {i}".encode() for i in range(3)}
        self.offer(new)
        self._killed_fetch(3, after=1)
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["unchanged"], out["added"], out["kept_both"], out["interrupted"]),
                         (1, 1, ["n1 (2).txt"], ["n1.txt"]))
        self.assertEqual((self.to / DEST / "n1.txt").read_bytes(), b"new")
        for name, data in new.items():
            got = self.to / DEST / ("n1 (2).txt" if name == "n1.txt" else name)
            self.assertEqual(got.read_bytes(), data)

    def test_marker_written_twice_per_run(self):
        """Once before the first write (every planned write pending), once at the end."""
        calls = []
        real = fr.write_marker

        def count(*a, **k):
            calls.append(a[0])
            return real(*a, **k)

        with mock.patch.object(fr, "write_marker", count):
            self.offer({f"f{i}.txt": b"a" * i for i in range(5)})
            self.fetch()
            self.assertEqual(len(calls), 2)
            calls.clear()
            self.offer({f"f{i}.txt": b"b" * (i + 1) for i in range(5)})
            code, out, _ = self.fetch()
            self.assertEqual((out["updated"], len(calls)), (5, 2))
            calls.clear()
            self.fetch()
            self.assertEqual(len(calls), 2)
        recorded = self.marker(self.to / DEST)["files"]
        self.assertFalse(any("pending" in r for r in recorded.values()))

    def test_unwritten_planned_files_leave_no_record(self):
        self.offer({"a.txt": b"1", "b.txt": b"2"})
        self.fake.blob_mode = {"1": "500"}
        code, out, _ = self.fetch()
        self.assertEqual((code, out["failed"]), (3, ["b.txt"]))
        self.assertEqual(sorted(self.marker(self.to / DEST)["files"]), ["a.txt"])

    def test_update_cut_off_leaves_a_strict_prefix(self):
        self.offer({"memo.docx": b"a much longer first version"})
        self.fetch()
        self.offer({"memo.docx": b"v2 short"})
        self._killed_fetch(3)
        self.assertEqual((self.to / DEST / "memo.docx").read_bytes(), b"v2 ")

    def test_same_size_user_edit_sharing_a_prefix_is_never_overwritten(self):
        """Every .xlsx and .docx starts with "PK": a user's file of the old (or new) size that
        shares a prefix with the new version must not pass for a cut-off write."""
        v1, v2 = b"PK" + b"x" * 20, b"PK" + b"y" * 30
        for mine in (b"PK" + b"z" * 20, b"PK" + b"z" * 30, b"PK" + b"y" * 29 + b"!"):
            with self.subTest(size=len(mine), tail=mine[-1:]):
                self.to = self.dir / f"pk{len(mine)}{mine[-1]}"
                self.to.mkdir()
                self.offer({"book.xlsx": v1})
                self.fetch()
                dest = self.to / DEST
                self.offer({"book.xlsx": v2})
                self._killed_fetch(4)
                self.assertEqual((dest / "book.xlsx").read_bytes(), v2[:4])
                (dest / "book.xlsx").write_bytes(mine)  # the user's own edit after the kill
                code, out, err = self.fetch()
                self.assertEqual(code, 0, err)
                self.assertEqual((out["updated"], out["kept_both"]), (0, ["book (2).xlsx"]))
                self.assertEqual((dest / "book.xlsx").read_bytes(), mine)
                self.assertEqual((dest / "book (2).xlsx").read_bytes(), v2)

    def test_racing_fetch_of_another_task_takes_the_name_first(self):
        """Another task's fetch creates and claims "Q3 report" between our scan and our claim:
        we must move on to "Q3 report (2)", never share its folder."""
        real_claim = fr.claim_marker
        raced = []

        def racing(folder, task_id):
            if not raced and os.path.basename(folder) == "Q3 report":
                raced.append(folder)
                real_claim(folder, "task-other0000")  # the other fetch wins the name
            return real_claim(folder, task_id)

        self.offer({"memo.docx": b"mine"})
        with mock.patch.object(fr, "claim_marker", racing):
            code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(self.marker(self.to / "Q3 report")["task_id"], "task-other0000")
        self.assertEqual(os.listdir(self.to / "Q3 report"), [fr.MARKER])
        self.assertEqual(self.marker(self.to / "Q3 report (2)")["task_id"], TASK)

    def test_empty_folder_adopted_only_by_winning_the_claim(self):
        (self.to / "Q3 report").mkdir()
        fr.claim_marker(str(self.to / "Q3 report"), "task-other0000")  # holds only a marker
        self.offer({"memo.docx": b"mine"})
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))

    def test_hard_linked_marker_makes_the_folder_not_ours(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        outside = self.dir / "outside.json"
        try:
            os.link(dest / fr.MARKER, outside)
        except (OSError, NotImplementedError):
            self.skipTest("hard links unavailable")
        before = outside.read_bytes()
        self.assertIsNone(fr.read_marker(str(dest)))
        self.assertFalse(fr.write_marker(str(dest), TASK, {}))
        self.offer({"memo.docx": b"v2"})
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(outside.read_bytes(), before)
        self.assertEqual((dest / "memo.docx").read_bytes(), b"v1")

    def test_symlinked_marker_makes_the_folder_not_ours(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        outside = self.dir / "outside.json"
        outside.write_bytes((dest / fr.MARKER).read_bytes())
        (dest / fr.MARKER).unlink()
        try:
            os.symlink(outside, dest / fr.MARKER)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        before = outside.read_bytes()
        self.offer({"memo.docx": b"v2"})
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(outside.read_bytes(), before)

    def test_kill_mid_update_then_user_edit_is_kept(self):
        self.offer({"memo.docx": b"short v1"})
        self.fetch()
        dest = self.to / DEST
        self.offer({"memo.docx": b"a much longer second version"})
        self._killed_fetch(5)
        (dest / "memo.docx").write_bytes(b"I fixed it myself")
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual(out["kept_both"], ["memo (2).docx"])
        self.assertEqual((dest / "memo.docx").read_bytes(), b"I fixed it myself")
        self.assertEqual((dest / "memo (2).docx").read_bytes(), b"a much longer second version")

    def test_kill_mid_create_keeps_the_cut_off_file(self):
        self.offer({"first.txt": b"1"})
        self.fetch()
        dest = self.to / DEST
        self.offer({"first.txt": b"1", "new.docx": b"brand new content"})
        self._killed_fetch(4)
        self.assertEqual((dest / "new.docx").read_bytes(), b"bran")
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["kept_both"], out["interrupted"]), (["new (2).docx"], ["new.docx"]))
        self.assertEqual((dest / "new.docx").read_bytes(), b"bran")
        self.assertEqual((dest / "new (2).docx").read_bytes(), b"brand new content")

    def test_kill_mid_create_then_user_edit_is_kept(self):
        self.offer({"first.txt": b"1"})
        self.fetch()
        dest = self.to / DEST
        self.offer({"first.txt": b"1", "new.docx": b"brand new content"})
        self._killed_fetch(4)
        (dest / "new.docx").write_bytes(b"mine now")
        code, out, _ = self.fetch()
        self.assertEqual(out["kept_both"], ["new (2).docx"])
        self.assertEqual((dest / "new.docx").read_bytes(), b"mine now")

    def test_pending_holding_other_bytes_is_never_overwritten(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        dest = self.to / DEST
        v2 = b"version two"
        (dest / "memo.docx").write_bytes(v2[:4])  # looks like a prefix of v2
        files = self.marker(dest)["files"]
        files["memo.docx"] = {"sha256": "", "size": 0,
                              "pending": {"prev_sha256": "0" * 64, "prev_size": 2}}
        fr.write_marker(str(dest), TASK, files)
        self.offer({"memo.docx": v2})
        code, out, _ = self.fetch()
        self.assertEqual((out["kept_both"], out["interrupted"]), (["memo (2).docx"], ["memo.docx"]))
        self.assertEqual((dest / "memo.docx").read_bytes(), v2[:4])

    def test_title_change_reuses_the_task_folder(self):
        self.offer({"memo.docx": b"m"}, suggested="Q3 report")
        self.fetch()
        (self.to / "Other work").mkdir()
        self.offer({"memo.docx": b"m", "b.txt": b"b"}, suggested="Q3 report, final")
        code, out, _ = self.fetch()
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report"))
        self.assertEqual((out["added"], out["unchanged"]), (1, 1))
        self.assertFalse((self.to / "Q3 report, final").exists())

    def test_record_lookup_ignores_case(self):
        files = {"Out/Report.docx": {"sha256": "x", "size": 1}}
        self.assertEqual(fr._lookup(files, "out/report.docx"),
                         ("Out/Report.docx", files["Out/Report.docx"]))
        self.assertEqual(fr._lookup(files, "other.docx"), ("other.docx", None))

    def test_marker_never_deleted_or_renamed(self):
        calls = []
        real_unlink, real_rename, real_replace = os.unlink, os.rename, os.replace

        def spy(real):
            def call(path, *a, **k):
                calls.append(str(path))
                return real(path, *a, **k)
            return call

        self.offer({"a.txt": b"1"})
        with mock.patch.object(fr.os, "unlink", spy(real_unlink)), \
                mock.patch.object(fr.os, "rename", spy(real_rename)), \
                mock.patch.object(fr.os, "replace", spy(real_replace)):
            self.fetch()
            self.offer({"a.txt": b"2"})
            self.fetch()
        self.assertEqual([c for c in calls if c.startswith(str(self.to))], [])
        self.assertEqual(self.marker(self.to / DEST)["files"]["a.txt"]["size"], 1)

    def test_marker_hidden_on_windows(self):
        seen = []
        with mock.patch.object(fr, "_IS_WINDOWS", True), \
                mock.patch.object(fr, "_set_attributes", lambda p, a: seen.append((p, a))):
            self.offer({"a.txt": b"1"})
            self.fetch()
        marker = str(self.to / DEST / fr.MARKER)
        self.assertIn((marker, 2), seen)

    def test_marker_hide_failure_is_harmless(self):
        def boom(p, a):
            raise OSError("no")

        with mock.patch.object(fr, "_IS_WINDOWS", True), mock.patch.object(fr, "_set_attributes", boom):
            self.offer({"a.txt": b"1"})
            code, _, err = self.fetch()
        self.assertEqual(code, 0, err)

    def test_delivered_marker_name_refused(self):
        self.offer({".frontier-task": b"{}", ".FRONTIER-TASK": b"{}", "sub/.frontier-task": b"ok",
                    "a.txt": b"1"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(sorted(out["failed"]), [".FRONTIER-TASK", ".frontier-task"])
        self.assertEqual(self.marker(self.to / DEST)["task_id"], TASK)
        self.assertTrue((self.to / DEST / "sub" / ".frontier-task").is_file())

    def test_second_fetch_is_unchanged(self):
        self.offer({"memo.docx": b"memo", "x/y.csv": b"1,2"})
        self.fetch()
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        self.assertEqual((out["files"], out["unchanged"]), (0, 2))
        self.assertIn("2 unchanged", err)
        self.assertEqual(self.files(), [f"{DEST}/memo.docx", f"{DEST}/x/y.csv"])

    def test_case_fold_collision_in_one_delivery(self):
        self.offer({"A.txt": b"upper", "a.txt": b"lower"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        got = sorted((self.to / DEST / p).read_bytes() for p in
                     [x.split("/", 1)[1] for x in self.files()])
        self.assertEqual(got, [b"lower", b"upper"])

    def _case_insensitive(self):
        """Patches that make paths under the destination behave as on macOS or Windows: a name
        resolves to an existing entry whose name matches it case-insensitively."""
        import builtins
        to = str(self.to)
        real = {"lexists": os.path.lexists, "islink": os.path.islink, "isdir": os.path.isdir,
                "exists": os.path.exists, "lstat": os.lstat, "stat": os.stat, "open": os.open,
                "mkdir": os.mkdir, "listdir": os.listdir}
        real_open = builtins.open

        def there(p):  # the unpatched primitive: no recursion through the patches
            try:
                real["lstat"](p)
                return True
            except OSError:
                return False

        def is_dir(p):
            try:
                return stat.S_ISDIR(real["stat"](p).st_mode)
            except OSError:
                return False

        def ci(path):
            p = os.fspath(path) if not isinstance(path, int) else path
            if not isinstance(p, str) or not p.startswith(to + os.sep):
                return path
            cur = to
            for part in p[len(to) + 1:].split(os.sep):
                nxt = os.path.join(cur, part)
                if not there(nxt) and is_dir(cur):
                    for entry in real["listdir"](cur):
                        if entry.casefold() == part.casefold():
                            nxt = os.path.join(cur, entry)
                            break
                cur = nxt
            return cur

        def wrap(fn):
            return lambda path, *a, **k: fn(ci(path), *a, **k)

        return [mock.patch.object(fr.os.path, "lexists", wrap(real["lexists"])),
                mock.patch.object(fr.os.path, "islink", wrap(real["islink"])),
                mock.patch.object(fr.os.path, "isdir", wrap(real["isdir"])),
                mock.patch.object(fr.os.path, "exists", wrap(real["exists"])),
                mock.patch.object(fr.os, "lstat", wrap(real["lstat"])),
                mock.patch.object(fr.os, "stat", wrap(real["stat"])),
                mock.patch.object(fr.os, "open", wrap(real["open"])),
                mock.patch.object(fr.os, "mkdir", wrap(real["mkdir"])),
                mock.patch.object(fr, "open", wrap(real_open), create=True)]

    def test_case_only_collision_on_a_case_insensitive_disk(self):
        """A.txt and a.txt in one delivery are one file on macOS and Windows: the second must
        never be written over the first."""
        patches = self._case_insensitive()
        for pt in patches:
            pt.start()
        try:
            self.offer({"A.txt": b"upper", "a.txt": b"lower"})
            code, out, err = self.fetch()
            self.assertEqual(code, 0, err)
            self.assertEqual((out["added"], out["kept_both"]), (1, ["a (2).txt"]))
            code, out, err = self.fetch()  # again: both found, nothing rewritten
            self.assertEqual((out["unchanged"], out["updated"], out["kept_both"]), (2, 0, []))
        finally:
            for pt in patches:
                pt.stop()
        dest = self.to / DEST
        self.assertEqual(sorted(os.listdir(dest)), [fr.MARKER, "A.txt", "a (2).txt"])
        self.assertEqual((dest / "A.txt").read_bytes(), b"upper")
        self.assertEqual((dest / "a (2).txt").read_bytes(), b"lower")

    def test_case_change_across_runs_still_updates_in_place_on_a_ci_disk(self):
        patches = self._case_insensitive()
        for pt in patches:
            pt.start()
        try:
            self.offer({"Report.docx": b"v1"})
            self.fetch()
            self.offer({"report.docx": b"version 2"})
            code, out, err = self.fetch()
            self.assertEqual(code, 0, err)
            self.assertEqual((out["updated"], out["kept_both"]), (1, []))
        finally:
            for pt in patches:
                pt.stop()
        dest = self.to / DEST
        self.assertEqual(sorted(os.listdir(dest)), [fr.MARKER, "Report.docx"])
        self.assertEqual((dest / "Report.docx").read_bytes(), b"version 2")

    def test_one_file_at_a_time_in_temp(self):
        seen = []
        real_merge = fr._merge

        def spy(parent, rel_parent, name, tmp, *a):
            seen.append(sorted(os.listdir(os.path.dirname(tmp))))
            return real_merge(parent, rel_parent, name, tmp, *a)

        self.offer({"a.txt": b"1", "b.txt": b"22", "c/d.txt": b"333"})
        with mock.patch.object(fr, "_merge", spy):
            code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual([len(x) for x in seen], [1, 1, 1])

    def test_refuses_escaping_paths(self):
        self.offer({"../x": b"bad", "/abs": b"bad", "a/../../y": b"bad", "ok.txt": b"ok"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(sorted(out["failed"]), sorted(["../x", "/abs", "a/../../y"]))
        self.assertEqual(out["files"], 1)
        self.assertFalse((self.dir / "x").exists())
        self.assertFalse((self.to / "x").exists())
        self.assertFalse(Path("/abs").exists())
        self.assertEqual(self.files(), [f"{DEST}/ok.txt"])

    def test_temp_folder_outside_destination_and_removed(self):
        made = []
        real = fr.tempfile.mkdtemp

        def spy(*a, **k):
            d = real(*a, **k)
            made.append(d)
            return d

        self.offer({"a.txt": b"1"})
        with mock.patch.object(fr.tempfile, "mkdtemp", spy):
            code, _, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(len(made), 1)
        self.assertFalse(made[0].startswith(str(self.to)))
        self.assertFalse(os.path.exists(made[0]))

    def test_empty_delivery_creates_nothing(self):
        self.offer({})
        code, out, err = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(out["files"], 0)
        self.assertEqual(list(self.to.iterdir()), [])

    def test_storage_unreachable_says_frontier_and_names_no_host(self):
        self.offer({"a.bin": b"abc"})
        self.fake.download["files"][0]["url"] = "https://127.0.0.1:1/get/0?sig=s3cr3t"
        code, out, err = self.fetch()
        self.assertEqual(code, 1)
        self.assertEqual(out["failed"], ["a.bin"])
        self.assertIn("Could not reach Frontier", err)
        for word in ("127.0.0.1", "allowlist"):
            self.assertNotIn(word, err)

    def _temp_open(self, fail_on: str):
        """An open() for the helper module whose temp-copy writes fail with ENOSPC."""
        import builtins
        real_open = builtins.open
        to = str(self.to)

        class Full:
            def __init__(self, f):
                self.f = f

            def write(self, data):
                raise OSError(errno.ENOSPC, "No space left on device")

            def __getattr__(self, name):
                return getattr(self.f, name)

            def __enter__(self):
                return self

            def __exit__(self, *a):
                self.f.close()

        def fake(path, mode="r", *a, **k):
            temp = "w" in mode and not str(path).startswith(to)
            if temp and fail_on == "open":
                raise OSError(errno.ENOSPC, "No space left on device")
            f = real_open(path, mode, *a, **k)
            return Full(f) if temp else f

        return fake

    def test_temp_disk_full_is_not_a_network_failure(self):
        for fail_on in ("open", "write"):
            with self.subTest(fail_on=fail_on):
                self.fake.requests.clear()
                self.offer({"memo.docx": b"memo"})
                with mock.patch.object(fr, "open", self._temp_open(fail_on), create=True):
                    code, out, err = self.fetch()
                self.assertEqual(code, 3, err)
                self.assertEqual(out["failed"], ["memo.docx"])
                self.assertIn("could not write a temporary copy: not enough space", err)
                self.assertNotIn("allowlist", err)
                self.assertNotIn("could not reach", err)
                gets = [p for m, p, _ in self.fake.requests if m == "GET" and p.startswith("/get/")]
                self.assertLessEqual(len(gets), 1, "a local error is not retried")

    def test_part_removed_on_failure(self):
        self.offer({"a.bin": b"abcdef", "b.bin": b"x", "c.bin": b"y"})
        self.fake.blob_mode = {"0": "short", "1": "500", "2": "redirect"}
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(sorted(out["failed"]), ["a.bin", "b.bin", "c.bin"])
        self.assertEqual([p for p in self.to.rglob("*") if p.is_file()], [])
        gets = [p for m, p, _ in self.fake.requests if m == "GET" and p.startswith("/get/other")]
        self.assertEqual(gets, [], "redirects are never followed")

    def test_size_mismatch_fails(self):
        self.offer({"a.bin": b"abc"})
        self.fake.download["files"][0]["size"] = 99
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["a.bin"])
        self.assertEqual([p for p in self.to.rglob("*") if p.is_file()], [])

    def test_rejects_plain_http_link(self):
        self.offer({"a.bin": b"abc"})
        self.fake.download["files"][0]["url"] = "http://example.com/get/0?sig=s3cr3t"
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(out["failed"], ["a.bin"])

    def test_suggested_dir_literal_and_fallback(self):
        cases = {"-weird": "-weird", "~home": "~home", ".dot": ".dot",
                 "..": "Frontier task 1234abcd", "a/b": "Frontier task 1234abcd",
                 "": "Frontier task 1234abcd", "con": "Frontier task 1234abcd",
                 ".frontier": "Frontier task 1234abcd", None: "Frontier task 1234abcd",
                 'Plan: "v2"?': "Plan- -v2--"}
        for i, (sd, want) in enumerate(cases.items()):
            with self.subTest(sd=sd):
                to = self.dir / f"d{i}"
                to.mkdir()
                self.offer({"f.txt": b"1"}, suggested=sd)
                code, out, err = self.fetch(to)
                self.assertEqual(code, 0, err)
                self.assertEqual(out["saved_to"], str(to / want))
                self.assertTrue((to / want / "f.txt").is_file())

    def test_long_title_variant_folder_name_fits(self):
        title = "é" * 127  # 254 bytes
        (self.to / title).mkdir()
        (self.to / title / "mine.txt").write_bytes(b"mine")
        self.offer({"f.txt": b"1"}, suggested=title)
        code, out, err = self.fetch()
        self.assertEqual(code, 0, err)
        name = os.path.basename(out["saved_to"])
        self.assertTrue(name.endswith(" (2)"))
        self.assertLessEqual(len(name.encode("utf-8")), 255)
        self.offer({"f.txt": b"1"}, suggested=title)  # found again by its marker
        code, out, _ = self.fetch()
        self.assertEqual((os.path.basename(out["saved_to"]), out["unchanged"]), (name, 1))

    def test_suffix_on_a_255_byte_name_is_truncated(self):
        for name in ("a" * 251 + ".txt", "é" * 125 + ".txt", "日" * 83 + "ab.pdf",
                     "a." + "x" * 252):
            with self.subTest(n=len(name.encode())):
                to = self.dir / f"t{len(name)}"
                to.mkdir()
                self.offer({name: b"v1"})
                self.fetch(to)
                (to / DEST / name).write_bytes(b"mine")  # the user edits it
                self.offer({name: b"theirs"})
                code, out, err = self.fetch(to)
                self.assertEqual(code, 0, err)
                self.assertEqual(len(out["kept_both"]), 1)
                new = out["kept_both"][0]
                self.assertLessEqual(len(new.encode("utf-8")), 255)
                self.assertIn(" (2)", new)
                stem, ext = fr._split_name(name)
                if len(ext.encode()) <= 64:
                    self.assertTrue(new.endswith(" (2)" + ext))
                self.assertEqual((to / DEST / name).read_bytes(), b"mine")
                self.assertEqual((to / DEST / new).read_bytes(), b"theirs")
                code, out, _ = self.fetch(to)
                self.assertEqual((out["files"], out["unchanged"]), (0, 1))

    def test_windows_characters_replaced_locally(self):
        self.offer({'notes/Q3: "final"?.md': b"x"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 0)
        self.assertTrue((self.to / DEST / "notes" / "Q3- -final--.md").is_file())

    def test_symlinked_subfolder_cannot_escape(self):
        self.offer({"first.txt": b"1"})
        self.fetch()
        dest = self.to / DEST
        outside = self.dir / "outside"
        outside.mkdir()
        try:
            os.symlink(outside, dest / "out")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        self.offer({"out/a.txt": b"x"})
        code, out, _ = self.fetch()
        self.assertEqual(code, 3)
        self.assertEqual(list(outside.iterdir()), [])


class Cli(Base):
    def _run(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(SCRIPT), *argv], capture_output=True, text=True,
                              timeout=60)

    def test_plain_http_ticket_refused_without_base(self):
        root = self.tree({"a.pdf": b"1"})
        p = self._run("stage", "--ticket", self.ticket, "--root", str(root))
        self.assertEqual(p.returncode, 2)
        self.assertEqual(self.fake.manifests, [])
        self.assertNotIn(RAW, p.stdout + p.stderr)

    def test_non_loopback_base_refused(self):
        p = self._run("fetch", "--ticket", f"https://evil.example/v1/connect/t#{RAW}",
                      "--to", str(self.dir), "--base", "https://evil.example")
        self.assertEqual(p.returncode, 2)

    def test_end_to_end_subprocess(self):
        root = self.tree({"a.pdf": b"1"})
        p = self._run("stage", "--ticket", self.ticket, "--root", str(root), "--base", self.fake.base)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["uploaded"], 1)

    def test_ticket_from_stdin(self):
        root = self.tree({"a.pdf": b"1"})
        p = subprocess.run([sys.executable, str(SCRIPT), "stage", "--ticket", "-", "--root", str(root),
                            "--base", self.fake.base], input=self.ticket + "\n",
                           capture_output=True, text=True, timeout=60)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(json.loads(p.stdout)["uploaded"], 1)

    def test_usage_errors(self):
        self.assertEqual(self._run().returncode, 2)
        self.assertEqual(self._run("stage", "--ticket", self.ticket).returncode, 2)
        p = self._run("stage", "--ticket", self.ticket, "--root", str(self.dir / "nope"),
                      "--base", self.fake.base)
        self.assertEqual(p.returncode, 2)


if __name__ == "__main__":
    unittest.main()


class SavedAck(Base):
    """After a fetch that saved files, the helper tells Frontier the task folder's NAME only."""

    def setUp(self) -> None:
        super().setUp()
        self.to = self.dir / "dest"
        self.to.mkdir()

    offer = Fetch.offer
    fetch = Fetch.fetch

    def test_acks_the_folder_it_actually_wrote_to(self):
        self.offer({"memo.md": b"m"})
        code, out, _err = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(self.fake.acks, [{"dir": "Q3 report"}])
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report"))

    def test_a_name_taken_by_other_work_acks_the_numbered_folder(self):
        (self.to / "Q3 report").mkdir()
        (self.to / "Q3 report" / "theirs.txt").write_bytes(b"x")
        self.offer({"memo.md": b"m"})
        code, out, _err = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report (2)"))
        self.assertEqual(self.fake.acks, [{"dir": "Q3 report (2)"}])

    def test_a_retitled_task_acks_the_folder_its_marker_names(self):
        self.offer({"memo.md": b"m"})
        self.fetch()
        self.offer({"memo.md": b"m2"}, suggested="Q3 report - revised")
        code, out, _err = self.fetch()
        self.assertEqual(code, 0)
        self.assertEqual(out["saved_to"], str(self.to / "Q3 report"))
        self.assertEqual(self.fake.acks, [{"dir": "Q3 report"}, {"dir": "Q3 report"}])

    def test_unchanged_files_still_ack_and_the_body_is_never_a_path(self):
        self.offer({"memo.md": b"m"})
        self.fetch()
        code, out, _err = self.fetch()
        self.assertEqual((code, out["unchanged"]), (0, 1))
        self.assertEqual(len(self.fake.acks), 2)
        for ack in self.fake.acks:
            self.assertEqual(set(ack), {"dir"})
            self.assertNotIn("/", ack["dir"])
            self.assertNotIn("\\", ack["dir"])
            self.assertNotIn(str(self.dir), ack["dir"])

    def test_one_file_failing_sends_no_ack(self):
        self.offer({"ok.md": b"fine", "bad.md": b"never arrives"})
        self.fake.blob_mode["1"] = "500"
        code, out, _err = self.fetch()
        self.assertEqual((code, out["added"], out["failed"]), (3, 1, ["bad.md"]))
        self.assertEqual(self.fake.acks, [])

    def test_every_file_saved_acks_once(self):
        self.offer({"a.md": b"a", "b/c.md": b"c"})
        code, out, _err = self.fetch()
        self.assertEqual((code, out["added"], out["failed"]), (0, 2, []))
        self.assertEqual(self.fake.acks, [{"dir": "Q3 report"}])

    def test_a_kept_both_fetch_still_acks(self):
        self.offer({"memo.docx": b"v1"})
        self.fetch()
        (self.to / "Q3 report" / "memo.docx").write_bytes(b"the user's edit")
        self.offer({"memo.docx": b"v2"})
        code, out, _err = self.fetch()
        self.assertEqual((code, out["kept_both"]), (0, ["memo (2).docx"]))
        self.assertEqual(self.fake.acks, [{"dir": "Q3 report"}, {"dir": "Q3 report"}])

    def test_nothing_saved_sends_no_ack(self):
        self.offer({})
        code, _out, _err = self.fetch()
        self.assertEqual(code, 0)
        self.fake.blob_mode["0"] = "500"
        self.offer({"memo.md": b"m"})
        self.fake.blob_mode["0"] = "500"
        code, _out, _err = self.fetch()
        self.assertNotEqual(code, 0)
        self.assertEqual(self.fake.acks, [])

    def test_a_refused_ack_is_silent_and_keeps_the_exit_code(self):
        for status in (404, 500, 400):
            with self.subTest(status=status):
                self.fake.ack_status = status
                self.offer({f"memo{status}.md": b"m"})
                code, out, err = self.fetch()
                self.assertEqual((code, out["added"]), (0, 1))
                self.assertNotIn("refused", err.lower())
                self.assertNotIn("expired", err.lower())
