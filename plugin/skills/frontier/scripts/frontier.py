#!/usr/bin/env python3
"""Frontier plugin helper: move a local folder up to a Frontier task, and bring the task's
delivered files back down. Python 3 standard library only.

    python3 frontier.py stage --ticket <ticket_url> --root <folder> [<path> ...]
    python3 frontier.py fetch --ticket <ticket_url> --to <folder>

The ticket URL comes from a Frontier tool result (frontier_request_upload or
frontier_request_download). Its secret part is the URL fragment: this helper sends it only in an
`Authorization: Ticket ...` header to api.parallelfrontier.io, never in a path or query, and never
prints or logs it. The helper stores no credentials. File bytes travel over the short-lived
presigned https links Frontier hands back, which must be https and are never followed through
redirects. The helper reads only inside --root and writes only inside --to.

Fetch saves into one folder per task under --to, found again on later fetches by a small marker
file (.frontier-task) recording what was delivered at each path. A file that still holds what
Frontier delivered last time is updated in place; a file the user changed (or that Frontier did
not put there) is kept and the new version saved alongside as "name (2)". Nothing in --to is
ever deleted or renamed, which a connected folder may refuse: downloads go to a private
temporary folder first and are then written into place.
After a fetch that saved every file, the helper tells Frontier the NAME of the task's folder
(never a path), so the task card can say the files are in the user's folder.
Pass `--ticket -` to read the ticket link from stdin instead of the command line.

Exit codes: 0 done, 1 Frontier or the network refused, 2 usage error, 3 some files failed.
JSON goes to stdout; lines for the user go to stderr.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import errno
import http.client
import json
import mimetypes
import os
import hashlib
import re
import shutil
import socket
import stat
import sys
import tempfile
import threading
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path

PROD_BASE = "https://api.parallelfrontier.io"
TICKET_PATH = "/v1/connect/t"
MAX_FILES = 1000
MAX_TOTAL_BYTES = 2 * 1024 ** 3
WORKERS = 4
TIMEOUT_S = 60
MAX_JSON_BYTES = 32 * 1024 * 1024
CHUNK = 1024 * 1024
USER_AGENT = "frontier-plugin/0.2.1"
DEFAULT_MIME = "application/octet-stream"

EXPIRED = ("This Frontier link has expired or was already used. Ask the assistant to request a "
           "new one and try again.")
RATE_LIMITED = "Frontier is rate limiting these requests. Wait a minute, then ask again."
PLAN_INACTIVE = ("Your Frontier plan is inactive, so Frontier cannot take files right now. Ask "
                 "your Frontier admin to restore the plan, then ask again.")
NO_ACCESS = ("Frontier refused access for this account. Check that you are connected to Frontier "
             "with the right account, then ask again.")
API_HOST = "api.parallelfrontier.io"
# PFL-65: the AI app's egress proxy refused api.parallelfrontier.io. The one case where the helper
# names a network setting: the user's own allowlist, and the only host they need to add.
NETWORK_BLOCKED = ("This app's network settings block api.parallelfrontier.io, so files cannot "
                   "reach Frontier from here. In Claude: Settings → Capabilities, add "
                   "api.parallelfrontier.io to the allowed domains (on Claude Team or Enterprise, an "
                   "org owner does this in Admin settings → Capabilities). Then ask again.")
# Top-level names Frontier writes into a task's folder itself; the server refuses a manifest
# that holds one, so the helper never sends them.
RESERVED_TOP_FILES = frozenset({"folder-index.md", "context.md"})


def _proxy_refused(exc: BaseException) -> bool:
    """True when a proxy refused the tunnel (CONNECT answered 403 or 407): a policy denial of the
    host, not a flaky connection."""
    text = f"{exc} {getattr(exc, 'reason', '')}"
    return "Tunnel connection failed: 403" in text or "Tunnel connection failed: 407" in text


def net_hint(hosts: set[str]) -> str:
    """What to say when Frontier could not be reached. It names api.parallelfrontier.io only when
    that host itself failed, never a storage host, and never asks the user to change network
    settings (spec 2026-10-20-connector-files-worker-design)."""
    if API_HOST in hosts:
        return f"Could not reach Frontier ({API_HOST}). Check the connection and try again."
    return "Could not reach Frontier. Check the connection and try again."


class UsageError(Exception):
    """Bad arguments or input: exit 2."""


class FrontierError(Exception):
    """Frontier or the network refused: exit 1. `status` is the HTTP status when Frontier answered."""

    def __init__(self, message: str = "", status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


# --- folder-relative paths: the same rules as Frontier's server-side check ------------------

MAX_RELPATH = 512
MAX_SEGMENT_BYTES = 255
RESERVED_TOP = ".frontier"
_DRIVE = re.compile(r"^[A-Za-z]:")
_BAD_CATEGORIES = frozenset({"Cc", "Cf", "Zl", "Zp"})
_WINDOWS_DEVICES = frozenset({"CON", "PRN", "AUX", "NUL"} | {f"COM{i}" for i in range(1, 10)}
                             | {f"LPT{i}" for i in range(1, 10)})
_WIN_CHARS = re.compile(r'[:*?"<>|]')


def _segment_ok(seg: str) -> bool:
    if seg in ("", ".", ".."):
        return False
    if seg[-1] in ". ":
        return False
    if len(seg.encode("utf-8")) > MAX_SEGMENT_BYTES:
        return False
    return seg.split(".", 1)[0].strip().upper() not in _WINDOWS_DEVICES


def safe_relpath(p: str) -> str:
    """The NFC form of `p`, or ValueError when it is not a safe folder-relative path."""
    if not isinstance(p, str):
        raise ValueError("path must be a string")
    p = unicodedata.normalize("NFC", p)
    if not p or len(p) > MAX_RELPATH:
        raise ValueError(f"path must be 1 to {MAX_RELPATH} characters")
    if any(unicodedata.category(c) in _BAD_CATEGORIES for c in p):
        raise ValueError("path has a control, format or line-separator character")
    if "\\" in p:
        raise ValueError("path must use / as its separator")
    if p.startswith("/") or _DRIVE.match(p):
        raise ValueError("path must be relative to the folder")
    segments = p.split("/")
    if not all(_segment_ok(seg) for seg in segments):
        raise ValueError("path has an empty, ., .., too long, reserved or dot/space-ending segment")
    if segments[0].casefold() == RESERVED_TOP:
        raise ValueError(f"{RESERVED_TOP} is reserved")
    return p


def relpath_key(p: str) -> str:
    """Two paths with the same key are the same file on macOS and Windows."""
    return unicodedata.normalize("NFC", p).casefold()


def local_segment(seg: str) -> str:
    """One path segment as written to disk: Windows' reserved characters become '-'."""
    return _WIN_CHARS.sub("-", seg)


# --- tickets and links -----------------------------------------------------------------------

_RAW = re.compile(r"[A-Za-z0-9_-]{16,256}")
_LOOPBACK = frozenset({"127.0.0.1", "localhost", "::1"})


def _loopback_base(base: str) -> str:
    """A test-only base URL: http(s) on a loopback host, nothing else."""
    parts = urllib.parse.urlsplit(base)
    if (parts.scheme not in ("http", "https") or parts.hostname not in _LOOPBACK
            or parts.username or parts.password or parts.path not in ("", "/")
            or parts.query or parts.fragment):
        raise UsageError("--base is for tests only and must be a loopback address")
    return f"{parts.scheme}://{parts.netloc}".lower()


def parse_ticket(url: str, base: str | None) -> tuple[str, str]:
    """(origin, secret) of a ticket URL `<origin>/v1/connect/t#<secret>`. Without a test base,
    the origin must be https://api.parallelfrontier.io. Error messages never echo the URL."""
    expected = PROD_BASE if base is None else _loopback_base(base)
    try:
        parts = urllib.parse.urlsplit(url)
        netloc = parts.netloc
    except ValueError:
        raise UsageError("the ticket is not a Frontier ticket link") from None
    if (parts.username or parts.password or f"{parts.scheme}://{netloc}".lower() != expected
            or parts.path != TICKET_PATH or parts.query or not _RAW.fullmatch(parts.fragment)):
        raise UsageError("the ticket is not a Frontier ticket link; ask the assistant for a new one")
    return expected, parts.fragment


def link_ok(url: object, test: bool) -> bool:
    """A presigned link must be https (plain http only to loopback, in tests)."""
    if not isinstance(url, str):
        return False
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname
    except ValueError:
        return False
    if not host or parts.username or parts.password:
        return False
    if parts.scheme == "https":
        return True
    return test and parts.scheme == "http" and host in _LOOPBACK


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        return None  # a 3xx surfaces as an HTTPError and is never followed


def _opener(test: bool) -> urllib.request.OpenerDirector:
    handlers: list = [_NoRedirect()]
    if test:
        handlers.append(urllib.request.ProxyHandler({}))  # loopback never goes through a proxy
    return urllib.request.build_opener(*handlers)


def _read_json(resp) -> dict:  # noqa: ANN001
    data = resp.read(MAX_JSON_BYTES + 1)
    if len(data) > MAX_JSON_BYTES:
        raise FrontierError("Frontier's answer was too large")
    try:
        out = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise FrontierError("Frontier's answer was not readable") from None
    if not isinstance(out, dict):
        raise FrontierError("Frontier's answer was not readable")
    return out


def _clean(text: object, limit: int = 200) -> str:
    s = "".join(c for c in str(text) if unicodedata.category(c)[0] != "C")
    return s[:limit]


def ticket_call(origin: str, raw: str, method: str, sub: str, body: dict | None, test: bool) -> dict:
    """One call to the ticket endpoint; the secret travels only in the Authorization header."""
    headers = {"Authorization": f"Ticket {raw}", "Accept": "application/json",
               "User-Agent": USER_AGENT}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(origin + TICKET_PATH + sub, data=data, method=method,
                                 headers=headers)
    try:
        with _opener(test).open(req, timeout=TIMEOUT_S) as resp:
            return _read_json(resp)
    except urllib.error.HTTPError as exc:
        code = exc.code
        detail = ""
        if code == 400:
            try:
                detail = _clean(json.loads(exc.read(64 * 1024)).get("detail", ""))
            except Exception:  # noqa: BLE001 - the detail is optional
                detail = ""
        exc.close()
        if code == 404:
            raise FrontierError(EXPIRED) from None
        if code == 429:
            raise FrontierError(RATE_LIMITED) from None
        if code == 400:
            raise FrontierError(f"Frontier refused the request: {detail or 'bad request'}",
                                status=400) from None
        if code == 402:  # the paid check: waiting will not fix it
            raise FrontierError(PLAN_INACTIVE) from None
        if code in (401, 403):
            raise FrontierError(NO_ACCESS) from None
        if code >= 500:
            raise FrontierError(f"Frontier answered HTTP {code}; try again in a moment") from None
        raise FrontierError(f"Frontier refused the request (HTTP {code}).") from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, socket.timeout) as exc:
        if _host(origin) == API_HOST and _proxy_refused(exc):
            raise FrontierError(NETWORK_BLOCKED) from None
        raise FrontierError(net_hint({_host(origin)})) from None


def _host(url: str) -> str:
    try:
        return urllib.parse.urlsplit(url).hostname or "?"
    except ValueError:
        return "?"


# Errors raised while a request or response is in flight. Only these count as network failures
# (retried once, reported as a network failure); local file errors never do.
_IN_FLIGHT = (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError,
              http.client.HTTPException)


def _network(exc: BaseException) -> bool:
    return isinstance(exc, _IN_FLIGHT) and not isinstance(exc, urllib.error.HTTPError)


def _retryable(exc: BaseException) -> bool:
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code >= 500
    return _network(exc)


def _local(exc: OSError, what: str) -> "_Failure":
    """A local file error as a per-file failure (never retried, never a network hint)."""
    full = exc.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", errno.ENOSPC))
    return _Failure(f"{what}: {'not enough space' if full else (exc.strerror or 'file error')}")


EXPIRED_LINK = "the link expired; ask the assistant for a new one and run again for this file"


def _describe(exc: BaseException) -> str:
    if isinstance(exc, urllib.error.HTTPError):
        return EXPIRED_LINK if exc.code == 403 else f"HTTP {exc.code}"
    if isinstance(exc, (socket.timeout, TimeoutError)):
        return "timed out"
    if isinstance(exc, _Failure):
        return str(exc)
    return "network error"


class _Failure(Exception):
    """A per-file failure that is not worth a retry."""


# --- stage: list a folder, post the manifest, PUT each file ------------------------------------

_SKIP_NAMES = frozenset({"thumbs.db", "desktop.ini"})


@dataclass
class Local:
    rel: str
    abs: str
    size: int
    explicit: bool
    dev: int = 0
    ino: int = 0

    @property
    def mime(self) -> str:
        return mimetypes.guess_type(self.rel.rsplit("/", 1)[-1])[0] or DEFAULT_MIME


def _inside(path: str, root_real: str) -> bool:
    """True when `path`, with every link and junction resolved, is `root_real` or under it."""
    real = os.path.normcase(os.path.realpath(path))
    root = os.path.normcase(root_real)
    try:
        return os.path.commonpath([real, root]) == root
    except ValueError:  # different drives
        return False


def _linked_dir(path: str) -> bool:
    """A folder that is really a pointer elsewhere: a symlink, a Windows junction or any
    other reparse point."""
    if os.path.islink(path):
        return True
    isjunction = getattr(os.path, "isjunction", None)  # Python 3.12+
    if isjunction is not None and isjunction(path):
        return True
    try:
        attrs = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return True
    return bool(attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _hidden(name: str, full: str) -> bool:
    if name.startswith(".") or name.startswith("~$") or name.casefold() in _SKIP_NAMES:
        return True
    try:
        st = os.lstat(full)
    except OSError:
        return True  # vanished while listing
    if getattr(st, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_HIDDEN", 0):
        return True  # Windows hidden attribute
    return bool(getattr(st, "st_flags", 0) & getattr(stat, "UF_HIDDEN", 0))  # macOS


def walk(root: Path, paths: list[str]) -> list[Local]:
    """The files to offer under `root`: every visible regular file, or only the listed paths
    (files, or folders walked the same way), which are flagged explicit. Skips hidden files and
    folders, Office lock files (~$*), .DS_Store, Thumbs.db, symlinked folders and links that
    leave the folder. Raises UsageError for a listed path outside `root`."""
    root_abs = os.path.abspath(str(root))
    root_real = os.path.realpath(root_abs)
    found: dict[str, Local] = {}

    def add(full: str, explicit: bool) -> None:
        if not _inside(full, root_real):  # every file, not only links: junctions, mounts
            return
        try:
            st = os.stat(full)
        except OSError:
            return
        if not stat.S_ISREG(st.st_mode):
            return
        rel = os.path.relpath(full, root_abs).replace(os.sep, "/")
        rel = unicodedata.normalize("NFC", rel)
        found.setdefault(rel, Local(rel, full, st.st_size, explicit, st.st_dev, st.st_ino))

    def walk_dir(top: str, explicit: bool) -> None:
        for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
            dirnames[:] = sorted(d for d in dirnames
                                 if not _linked_dir(os.path.join(dirpath, d))
                                 and not _hidden(d, os.path.join(dirpath, d))
                                 and _inside(os.path.join(dirpath, d), root_real))
            for name in sorted(filenames):
                full = os.path.join(dirpath, name)
                if not _hidden(name, full):
                    add(full, explicit)

    if not paths:
        walk_dir(root_abs, False)
    for p in paths:
        full = os.path.abspath(p if os.path.isabs(p) else os.path.join(root_abs, p))
        lexical_ok = full == root_abs or full.startswith(root_abs.rstrip(os.sep) + os.sep)
        if not lexical_ok or not _inside(full, root_real):
            raise UsageError(f"{p} is not inside {root}")
        if not os.path.lexists(full):
            raise UsageError(f"{p} does not exist")
        if os.path.isdir(full):  # a link to a folder inside root counts, it was checked above
            walk_dir(full, True)
        else:
            add(full, True)
    return sorted(found.values(), key=lambda f: f.rel)


class _Exact:
    """A file reader that yields exactly `size` bytes, or fails if the file got shorter."""

    def __init__(self, f, size: int) -> None:  # noqa: ANN001
        self.f, self.left = f, size

    def read(self, n: int = -1) -> bytes:
        if self.left <= 0:
            return b""
        n = self.left if n is None or n < 0 else min(n, self.left)
        try:
            data = self.f.read(n)
        except OSError as exc:
            raise _local(exc, "could not read the file") from None
        if not data:
            raise _Failure("the file changed while uploading")
        self.left -= len(data)
        return data


_HEADER_NAME = re.compile(r"[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}")
_DROP_HEADERS = frozenset({"content-length", "host", "transfer-encoding", "connection",
                           "authorization"})


def _put_range(item: Local, url: str, up: dict, offset: int, length: int, test: bool) -> None:
    """PUT `length` bytes of the file from `offset` (the whole file, or one part)."""
    headers = {"User-Agent": USER_AGENT}
    for k, v in (up.get("headers") or {}).items():
        if (not isinstance(k, str) or not isinstance(v, str) or not _HEADER_NAME.fullmatch(k)
                or "\r" in v or "\n" in v):
            raise _Failure("Frontier sent an unusable upload header")
        if k.lower() not in _DROP_HEADERS:
            headers[k] = v
    if not any(k.lower() == "content-type" for k in headers):
        headers["Content-Type"] = DEFAULT_MIME
    try:
        fd = os.open(item.abs, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        raise _Failure("the file is no longer there") from None
    with os.fdopen(fd, "rb") as f:
        st = os.fstat(f.fileno())
        if st.st_size != item.size or (item.ino and (st.st_dev, st.st_ino) != (item.dev, item.ino)):
            raise _Failure("the file changed since it was listed")
        f.seek(offset)
        headers["Content-Length"] = str(length)
        req = urllib.request.Request(url, data=_Exact(f, length), method="PUT", headers=headers)
        with _opener(test).open(req, timeout=TIMEOUT_S) as resp:
            resp.read(64 * 1024)


def _part_plan(up: dict, size: int, test: bool) -> list[tuple[int, int, int, str]] | None:
    """[(n, offset, length, url)] for a multipart entry, or None when it is unusable: parts must
    be numbered 1..N, each a positive size with an https link, adding up to the file's size."""
    parts = up.get("parts")
    if not isinstance(parts, list) or not parts:
        return None
    out: list[tuple[int, int, int, str]] = []
    off = 0
    for n, p in enumerate(parts, 1):
        if (not isinstance(p, dict) or type(p.get("n")) is not int or p["n"] != n
                or type(p.get("size")) is not int
                or p["size"] <= 0 or not link_ok(p.get("put_url"), test)):
            return None
        out.append((n, off, p["size"], p["put_url"]))
        off += p["size"]
    return out if off == size else None


def _with_retry(url: str, fn, *args) -> tuple[str | None, str | None]:  # noqa: ANN001
    """(None, None) on success, else (short reason, unreachable host or None). One retry on a
    5xx, timeout or network error. The reason never holds the URL."""
    for attempt in (1, 2):
        try:
            fn(*args)
            return None, None
        except _Failure as exc:
            return str(exc), None
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            if attempt == 2 or not _retryable(exc):
                host = _host(url) if _network(exc) else None
                if host:
                    return "could not reach Frontier", host
                if isinstance(exc, OSError) and not isinstance(exc, urllib.error.HTTPError):
                    return str(_local(exc, "file error")), None
                return _describe(exc), None
    return "failed", None


def stage(args: argparse.Namespace) -> int:
    origin, raw = parse_ticket(args.ticket, args.base)
    test = args.base is not None
    root = Path(args.root)
    if not root.is_dir():
        raise UsageError(f"{root} is not a folder")
    listed = walk(root, args.paths)
    files: list[Local] = []
    not_sent: list[str] = []
    keys: set[str] = set()
    reserved: list[str] = []
    for f in listed:
        try:
            f.rel = safe_relpath(f.rel)
        except ValueError:
            not_sent.append(f.rel)
            continue
        if relpath_key(f.rel) in RESERVED_TOP_FILES:
            reserved.append(f.rel)
            not_sent.append(f.rel)
            continue
        if relpath_key(f.rel) in keys:
            not_sent.append(f.rel)
            continue
        keys.add(relpath_key(f.rel))
        files.append(f)
    if reserved:
        print(f"Not sent: {', '.join(reserved)}. Frontier writes context.md and folder-index.md "
              "at the top of a task's folder itself; rename these to send them.", file=sys.stderr)
    if not files:
        raise UsageError("there are no files to upload in that folder")
    if len(files) > MAX_FILES:
        raise UsageError(f"that folder has {len(files)} files; Frontier takes at most {MAX_FILES} "
                         "per task. Pick a subfolder, or list the files to send.")
    if sum(f.size for f in files) > MAX_TOTAL_BYTES:
        raise UsageError("those files add up to more than 2 GiB; pick a subfolder, or list the "
                         "files to send.")
    manifest = []
    for f in files:
        entry: dict = {"path": f.rel, "size": f.size, "mime": f.mime}
        if f.explicit:
            entry["explicit"] = True
        manifest.append(entry)
    print(f"Listing {len(files)} files for Frontier...", file=sys.stderr)
    try:
        resp = ticket_call(origin, raw, "POST", "/manifest", {"files": manifest, "multipart": True}, test)
    except FrontierError as exc:
        if exc.status != 400:
            raise
        # A backend from before multipart rejects the unknown field before it uses the ticket:
        # ask once more without it and every file gets a single put_url.
        resp = ticket_call(origin, raw, "POST", "/manifest", {"files": manifest}, test)
    by_rel = {f.rel: f for f in files}
    uploads = resp.get("uploads") if isinstance(resp.get("uploads"), list) else []
    skipped = resp.get("skipped") if isinstance(resp.get("skipped"), list) else []
    failed: list[str] = []
    bad_plans: list[str] = []  # an open upload server-side whose plan we cannot use: abort it
    singles: list[tuple[Local, dict]] = []
    multis: dict[str, tuple[Local, dict, list]] = {}
    seen: set[str] = set()
    for up in uploads:
        path = up.get("path") if isinstance(up, dict) else None
        item = by_rel.get(path) if isinstance(path, str) else None
        if item is None or path in seen:
            failed.append(path if isinstance(path, str) else "?")
            continue
        plan = _part_plan(up, item.size, test) if "parts" in up else None
        if plan is None and ("parts" in up or not link_ok(up.get("put_url"), test)):
            failed.append(path)
            if "parts" in up:
                bad_plans.append(path)
            continue
        seen.add(path)
        if plan is None:
            singles.append((item, up))
        else:
            multis[path] = (item, up, plan)
    jobs = [(item, up["put_url"], up, 0, item.size) for item, up in singles]
    jobs += [(item, url, up, off, n) for item, up, plan in multis.values() for _i, off, n, url in plan]
    reasons: dict[str, str] = {}
    net: set[str] = set()
    hosts: set[str] = set()
    broken: dict[str, str] = {}  # rel -> why its first part failed; later parts are not sent
    broken_lock = threading.Lock()

    def send(j: tuple) -> tuple[str, tuple[str | None, str | None]]:
        rel = j[0].rel
        with broken_lock:
            why = broken.get(rel)
        if why is not None:
            return rel, (why, None)
        res = _with_retry(j[1], _put_range, *j, test)
        if res[0] is not None:
            with broken_lock:
                broken.setdefault(rel, res[0])
        return rel, res

    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for rel, (reason, host) in pool.map(send, jobs):
            if reason is not None:
                reasons.setdefault(rel, reason)
                if host:
                    hosts.add(host)
                    net.add(rel)
    if multis or bad_plans:
        done = [r for r in multis if r not in reasons]
        dropped = [r for r in multis if r in reasons] + bad_plans
        try:
            fin = ticket_call(origin, raw, "POST", "/complete", {"complete": done, "abort": dropped}, test)
            fin = fin if isinstance(fin, dict) else {}
            done_l = fin.get("completed") if isinstance(fin.get("completed"), list) else []
            fail_l = fin.get("failed") if isinstance(fin.get("failed"), list) else []
            completed = {p for p in done_l if isinstance(p, str)}
            told = {f["path"]: _clean(f.get("reason")) for f in fail_l
                    if isinstance(f, dict) and isinstance(f.get("path"), str)}
            for r in done:
                if r not in completed:
                    reasons[r] = told.get(r) or "Frontier could not finish the upload"
        except FrontierError as exc:
            for r in done:
                reasons[r] = str(exc)
    uploaded = 0
    for rel in [i.rel for i, _ in singles] + list(multis):
        if rel in reasons:
            failed.append(rel)
            print(f"Could not upload {rel}: {reasons[rel]}", file=sys.stderr)
        else:
            uploaded += 1
    net_failed = len(net & set(failed))
    out: dict = {"task_id": resp.get("task_id"), "uploaded": uploaded, "skipped": len(skipped),
                 "failed": failed}
    if not_sent:
        out["not_sent"] = not_sent
        if len(not_sent) > len(reserved):
            print(f"{len(not_sent) - len(reserved)} files were not sent: their names are not usable "
                  "on every system.", file=sys.stderr)
    if hosts:
        print(net_hint(hosts), file=sys.stderr)
    print(f"Uploaded {uploaded} files to Frontier. {len(skipped)} more stay listed for Frontier "
          "to ask for if the task needs them.", file=sys.stderr)
    print(json.dumps(out))
    if failed and uploaded == 0 and net_failed == len(failed):
        return 1
    return 3 if failed else 0


# --- fetch: list the delivered files, GET each into the destination -----------------------------

_TASK_CHARS = re.compile(r"[^A-Za-z0-9]")


def dir_name(suggested: object, task_id: object) -> str:
    """The base folder name: Frontier's suggested name taken literally as ONE safe segment,
    else 'Frontier task <first 8 of the id>'. find_dest() picks this name or a " (n)" variant."""
    tid = task_id if isinstance(task_id, str) else ""
    if tid.startswith("task-"):
        tid = tid[len("task-"):]
    fallback = f"Frontier task {_TASK_CHARS.sub('', tid)[:8] or 'files'}"
    if not isinstance(suggested, str):
        return fallback
    name = local_segment(suggested)
    try:
        if "/" not in name and safe_relpath(name) == name:
            return name
    except ValueError:
        pass
    return fallback


def _split_name(name: str) -> tuple[str, str]:
    dot = name.rfind(".")
    return (name[:dot], name[dot:]) if dot > 0 else (name, "")


MAX_EXT_BYTES = 64


def _cut(text: str, max_bytes: int) -> str:
    """`text` cut to at most `max_bytes` UTF-8 bytes, on a character boundary."""
    return text.encode("utf-8")[:max(max_bytes, 0)].decode("utf-8", "ignore")


def with_suffix(name: str, suffix: str, keep_ext: bool = True) -> str:
    """`name` with `suffix` (" (2)", " (1234abcd)") before its extension, the stem cut on a
    character boundary so the whole segment stays within 255 UTF-8 bytes. An extension longer
    than 64 bytes is cut too. The result never ends in a dot or a space."""
    stem, ext = _split_name(name) if keep_ext else (name, "")
    if len((stem + suffix + ext).encode("utf-8")) <= MAX_SEGMENT_BYTES:
        return stem + suffix + ext
    if len(ext.encode("utf-8")) > MAX_EXT_BYTES:
        ext = _cut(ext, MAX_EXT_BYTES).rstrip(". ")
    room = MAX_SEGMENT_BYTES - len(suffix.encode("utf-8")) - len(ext.encode("utf-8"))
    stem = _cut(stem, room).rstrip(". ") or "_"
    return stem + suffix + ext


_MAX_SUFFIX = 10000
MARKER = ".frontier-task"
MARKER_MAX_BYTES = 16 * 1024 * 1024
_IS_WINDOWS = os.name == "nt"
_FILE_ATTRIBUTE_HIDDEN = 0x2


class _Partial(Exception):
    """Writing into a destination file failed after it was opened."""


def _make_dirs(dest: str, segments: list[str]) -> str:
    """Create dest/segments one level at a time, refusing links and files on the way."""
    cur = dest
    for seg in segments:
        cur = os.path.join(cur, seg)
        if os.path.islink(cur):
            raise _Failure("a folder on the way is a link")
        if os.path.lexists(cur):
            if not os.path.isdir(cur):
                raise _Failure("a file is in the way of its folder")
            continue
        os.mkdir(cur)
    return cur


def _sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(CHUNK), b""):
            h.update(chunk)
    return h.hexdigest()


def _regular(path: str) -> bool:
    try:
        return stat.S_ISREG(os.lstat(path).st_mode)
    except OSError:
        return False


def _same(path: str, size: int, digest: str) -> bool:
    """True when `path` is a regular file (not a link) holding exactly these bytes."""
    try:
        st = os.lstat(path)
        return stat.S_ISREG(st.st_mode) and st.st_size == size and _sha256(path) == digest
    except OSError:
        return False


def _current_hash(path: str) -> str | None:
    try:
        return _sha256(path) if _regular(path) else None
    except OSError:
        return None


# --- the destination folder's marker ---------------------------------------------------------

def _set_attributes(path: str, attrs: int) -> None:
    import ctypes  # Windows only
    ctypes.windll.kernel32.SetFileAttributesW(str(path), attrs)  # type: ignore[attr-defined]


def _hide(path: str) -> None:
    """Best effort: mark the marker hidden on Windows (dot names are hidden elsewhere)."""
    if not _IS_WINDOWS:
        return
    try:
        _set_attributes(path, _FILE_ATTRIBUTE_HIDDEN)
    except Exception:  # noqa: BLE001 - cosmetic only
        pass


def _open_marker(path: str, mode: int) -> int | None:
    """An fd on an existing marker, or None when it fails the same checks as a delivered file:
    a regular file, not a link, a single link (no hard link to a file elsewhere), and the very
    file that was checked (O_NOFOLLOW where available, then dev/ino compared)."""
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        return None
    fd = os.open(path, mode | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    fst = os.fstat(fd)
    if (not stat.S_ISREG(fst.st_mode) or fst.st_nlink != 1
            or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino)):
        os.close(fd)
        return None
    return fd


def _marker_body(task_id: str, files: dict) -> bytes:
    return json.dumps({"version": 1, "task_id": task_id, "files": files}, sort_keys=True,
                      separators=(",", ":")).encode("utf-8")


def claim_marker(folder: str, task_id: str) -> bool:
    """Claim a folder for this task: create its marker exclusively. False when a marker (or
    anything else by that name) is already there; the caller then reads it."""
    path = os.path.join(folder, MARKER)
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
             | getattr(os, "O_NOFOLLOW", 0))
    try:
        fd = os.open(path, flags, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "wb") as out:
        out.write(_marker_body(task_id, {}))
        out.flush()
        os.fsync(out.fileno())
    _hide(path)
    return True


def read_marker(folder: str) -> dict | None:
    """The folder's marker as {"task_id", "files"}, or None when it is missing, a link,
    unreadable or not ours. Never raises."""
    path = os.path.join(folder, MARKER)
    try:
        fd = _open_marker(path, os.O_RDONLY)
        if fd is None:
            return None
        with os.fdopen(fd, "rb") as f:
            raw = f.read(MARKER_MAX_BYTES + 1)
        if len(raw) > MARKER_MAX_BYTES:
            return None
        data = json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None
    if (not isinstance(data, dict) or data.get("version") != 1
            or not isinstance(data.get("task_id"), str) or not isinstance(data.get("files"), dict)):
        return None
    files = {k: v for k, v in data["files"].items()
             if isinstance(k, str) and isinstance(v, dict) and isinstance(v.get("sha256"), str)}
    return {"task_id": data["task_id"], "files": files}


def write_marker(folder: str, task_id: str, files: dict, sync: bool = True) -> bool:
    """Write the marker in place: an existing marker is opened and overwritten (then cut to
    length), never deleted or renamed, which a connected folder may refuse. A link in its
    place, or a hard-linked one, is left alone. Returns False when it could not be written."""
    path = os.path.join(folder, MARKER)
    body = _marker_body(task_id, files)
    base = os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        if os.path.lexists(path):
            fd = _open_marker(path, os.O_WRONLY)  # same checks as a delivered file
            if fd is None:
                return False
        else:
            fd = os.open(path, base | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, "wb") as out:
            out.write(body)
            out.truncate()
            out.flush()
            if sync:
                os.fsync(out.fileno())
    except OSError:
        return False
    _hide(path)
    return True


def _variant(base: str, n: int) -> str:
    return base if n == 1 else with_suffix(base, f" ({n})", keep_ext=False)


MAX_SCAN = 5000
_VARIANT = re.compile(r" \((\d{1,5})\)$")


def find_dest(to: str, base: str, task_id: str) -> tuple[str, dict]:
    """(folder, recorded files) for this task under `to`. A direct child folder whose marker
    names this task is reused. Otherwise the first of `base`, `base (2)`, ... that does not
    exist, or is an empty real folder, is created or adopted, and claimed by creating its
    marker exclusively. A non-empty folder without our marker, or with another task's, is
    never adopted."""
    to_real = os.path.realpath(to)
    try:
        entries = os.listdir(to)
    except OSError as exc:
        raise _local(exc, "could not read the destination folder") from None
    candidates = []
    for name in entries:
        if name == base:
            candidates.append((1, name))
            continue
        m = _VARIANT.search(name)
        if m and _variant(base, int(m.group(1))) == name:
            candidates.append((int(m.group(1)), name))
    # Names that fit the title first, then any other direct child folder (the title may have
    # changed since the last fetch), bounded so a huge folder stays cheap.
    named = [name for _n, name in sorted(candidates)]
    others = sorted(set(entries[:MAX_SCAN]) - set(named))
    for name in named + others:
        if name.startswith(MARKER):
            continue
        path = os.path.join(to, name)
        if not os.path.isdir(path) or _linked_dir(path) or not _inside(path, to_real):
            continue
        marker = read_marker(path)
        if marker and marker["task_id"] == task_id:
            return path, marker["files"]
    for n in range(1, _MAX_SUFFIX):
        path = os.path.join(to, _variant(base, n))
        try:
            try:
                os.mkdir(path)
            except FileExistsError:
                pass  # there already (maybe made a moment ago by another fetch): checked below
            if (not os.path.isdir(path) or _linked_dir(path) or not _inside(path, to_real)
                    or os.path.realpath(path) == to_real):
                continue
            if any(e != MARKER for e in os.listdir(path)):
                continue  # never adopt a folder holding anything but a marker
            # Ownership is claimed by creating the marker exclusively, before any planning or
            # writing: of two fetches racing for this name, exactly one wins it.
            if claim_marker(path, task_id):
                return path, {}
        except OSError as exc:
            raise _local(exc, "could not create the destination folder") from None
        marker = read_marker(path)
        if marker and marker["task_id"] == task_id:
            return path, marker["files"]
    raise _Failure("could not create the destination folder")


# --- writing one delivered file ----------------------------------------------------------------

def _copy_into(fd: int, tmp: str, path: str) -> None:
    try:
        with os.fdopen(fd, "wb") as out, open(tmp, "rb") as src:
            shutil.copyfileobj(src, out, CHUNK)
            out.truncate()
            out.flush()
            os.fsync(out.fileno())
    except OSError as exc:
        raise _Partial(path) from exc


class _NotOurs(Exception):
    """The destination file cannot be updated in place: save the new version alongside."""


def _create(path: str, tmp: str) -> bool:
    """Create `path` exclusively and fill it; False when the name is taken."""
    flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0)
             | getattr(os, "O_NOFOLLOW", 0))
    try:
        fd = os.open(path, flags, 0o644)
    except FileExistsError:
        return False
    _copy_into(fd, tmp, path)
    return True


def _update_in_place(path: str, tmp: str) -> None:
    """Overwrite an existing regular file with new bytes, through the same file: no delete,
    no rename, no new file. Refused (_NotOurs) for a link, a hard-linked file (the write would
    reach its other names, possibly outside the folder), anything swapped in for the file,
    and a file another app holds open or read-only. The file is emptied before the new bytes
    go in, so an interruption leaves a strict prefix of the new version."""
    st = os.lstat(path)
    if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
        raise _NotOurs(path)
    flags = os.O_WRONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags)
    except OSError as exc:  # a link swapped in (ELOOP), locked or read-only (Windows: EACCES)
        raise _NotOurs(path) from exc
    fst = os.fstat(fd)
    if (not stat.S_ISREG(fst.st_mode) or fst.st_nlink != 1
            or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino)):
        os.close(fd)
        raise _NotOurs(path)
    # Empty the file first (only now that it is known to be the right one), so a write cut off
    # at any point leaves a strict prefix of the new version and nothing else.
    try:
        os.ftruncate(fd, 0)
    except OSError as exc:
        os.close(fd)
        raise _NotOurs(path) from exc
    _copy_into(fd, tmp, path)


# After an interrupted fetch, a path still marked pending is resolved only by its bytes, and
# only in the two cases that cannot be anyone's edit:
#   - it holds exactly the recorded old bytes: the write never started, so it is updated in
#     place as usual;
#   - it holds exactly the new version: the write finished, so it is just recorded.
# Anything else (a cut-off write, or a cut-off write the user has since changed: content cannot
# tell these apart) is kept as it is, and the new version is saved alongside and reported as
# `interrupted`, so the user can see which copy is complete.


def _pending_entry(prev: object) -> dict:
    """A record saying "we are about to write here", with what the path held before (its
    recorded hash and size, or nothing for a new file). The run's marker holds these until its
    last write replaces them."""
    prev_d = prev if isinstance(prev, dict) else None
    return {"sha256": prev_d.get("sha256", "") if prev_d else "",
            "size": prev_d.get("size", 0) if prev_d else 0,
            "pending": {"prev_sha256": prev_d.get("sha256") if prev_d else None,
                        "prev_size": prev_d.get("size") if prev_d else None}}


def _plan(dest: str, segs: list[str], files: dict, prior: object = None) -> str | None:
    """Before the run's first write, mark pending the path this file will most likely be
    written to (the first missing name, or our untouched file), so that one marker write up
    front covers every write of the run. An earlier interrupted write keeps its record.
    Returns the key of a planned create, which the run's end drops again if unused."""
    parent = dest
    for seg in segs[:-1]:
        parent = os.path.join(parent, seg)
        if os.path.islink(parent) or (os.path.lexists(parent) and not os.path.isdir(parent)):
            return
    rel_parent = "/".join(segs[:-1])
    for n in range(1, _MAX_SUFFIX):
        cand = segs[-1] if n == 1 else with_suffix(segs[-1], f" ({n})")
        path = os.path.join(parent, cand)
        k, rec = _lookup(files, f"{rel_parent}/{cand}" if rel_parent else cand, prior)
        if isinstance(rec, dict) and isinstance(rec.get("pending"), dict):
            return None
        if not os.path.lexists(path):
            if k in files:
                return None  # planned already by another delivered path in this run
            files[k] = _pending_entry(None)
            return k
        try:
            st = os.lstat(path)
        except OSError:
            continue
        if (isinstance(rec, dict) and stat.S_ISREG(st.st_mode) and st.st_nlink == 1
                and _current_hash(path) == rec.get("sha256")):
            files[k] = _pending_entry(rec)
            return None
    return None


def _lookup(files: dict, key: str, prior: object = None) -> tuple[str, object]:
    """(stored key, record) for `key`. A record from an earlier run (a key in `prior`, all keys
    when None) also matches case-insensitively, as macOS and Windows match names; a record
    made in this run never does, so two delivered paths differing only by case can never
    reach each other's file through it."""
    if key in files:
        return key, files[key]
    k = relpath_key(key)
    for stored in (files if prior is None else prior):
        if stored in files and relpath_key(stored) == k:
            return stored, files[stored]
    return key, None


def _merge(parent: str, rel_parent: str, name: str, tmp: str, size: int, digest: str,
           files: dict, persist=None, claimed: set | None = None,  # noqa: ANN001
           prior: object = None, interrupted: list | None = None) -> tuple[str, str]:
    """Put the downloaded bytes (`tmp`) at parent/name. Returns (outcome, written relpath),
    outcome one of added, unchanged, updated, kept_both. Never deletes or renames anything.

    - missing: created;  same bytes already there: unchanged;
    - still what we last delivered (the marker's hash; for a path left pending by an
      interrupted fetch, the recorded old bytes): updated in place;
    - left pending by an interrupted fetch and holding anything else: kept, the new version
      saved alongside, and the path added to `interrupted`;
    - changed by the user, not ours, hard-linked or locked: kept, and the new version goes to
      `name (n)`, where a copy we saved before is reused the same way.
    Every write happens under a pending record already saved in the marker (planned up front,
    or saved through `persist` when the write lands elsewhere), so a kill mid-write is
    recognised and finished by the next fetch.

    `claimed` holds the case-folded paths this run already wrote or kept: a later delivered
    path that differs from one of them only by case (the same file on macOS and Windows) is
    never written over it and goes to `name (n)` instead (kept_both)."""
    persist = persist or (lambda: None)
    claimed = set() if claimed is None else claimed
    cut_off: list[str] = []  # pending paths of ours that an interrupted fetch left unresolved

    def _done(outcome: str, k: str) -> tuple[str, str]:
        if outcome == "kept_both" and cut_off:
            # Reported once; from now on those files are the user's, not ours.
            for c in cut_off:
                files.pop(c, None)
            if interrupted is not None:
                interrupted.extend(cut_off)
        return outcome, k

    def key(n: str) -> str:
        return f"{rel_parent}/{n}" if rel_parent else n

    def mark(k: str, prev: object) -> None:
        """Planned writes were marked up front; only a write that went elsewhere than planned
        (the folder changed during the run) saves the marker again first."""
        cur = files.get(k)
        if isinstance(cur, dict) and isinstance(cur.get("pending"), dict):
            return
        files[k] = _pending_entry(prev)
        persist()

    for n in range(1, _MAX_SUFFIX):
        cand = name if n == 1 else with_suffix(name, f" ({n})")
        path = os.path.join(parent, cand)
        if relpath_key(key(cand)) in claimed:
            continue
        k, rec = _lookup(files, key(cand), prior)
        claim = relpath_key(key(cand))
        if not os.path.lexists(path):
            mark(k, None)
            claimed.add(claim)
            if not _create(path, tmp):
                claimed.discard(claim)
                if rec is None:
                    files.pop(k, None)
                else:
                    files[k] = rec
                continue
            files[k] = {"sha256": digest, "size": size}
            claimed.add(claim)
            return _done("added" if n == 1 else "kept_both", k)
        if _same(path, size, digest):
            files[k] = {"sha256": digest, "size": size}
            claimed.add(claim)
            return _done("unchanged", k)
        ours = False
        if isinstance(rec, dict) and _regular(path):
            cur = _current_hash(path)
            pending = rec.get("pending") if isinstance(rec.get("pending"), dict) else None
            ours = (cur == rec.get("sha256") and pending is None) \
                or (pending is not None and cur == pending.get("prev_sha256"))
            if pending is not None and not ours:
                cut_off.append(k)
        if not ours:
            continue
        prev = {"sha256": _current_hash(path), "size": os.lstat(path).st_size}
        mark(k, prev)
        claimed.add(claim)  # from here on this name is this run's, even if the write fails
        try:
            _update_in_place(path, tmp)
        except _NotOurs:
            files[k] = rec
            claimed.discard(claim)
            continue
        except OSError:
            files[k] = rec  # nothing was written
            raise
        files[k] = {"sha256": digest, "size": size}
        return _done("updated" if n == 1 else "kept_both", k)
    raise _Failure("too many files with this name")


def _get_once(url: str, tmp: str, size: int, test: bool, digest: list) -> None:
    """Stream one link into `tmp`, hashing as it goes. Network errors propagate (and are
    retried); local write errors become a _Failure."""
    req = urllib.request.Request(url, method="GET", headers={"User-Agent": USER_AGENT})
    h = hashlib.sha256()
    try:
        out = open(tmp, "wb")
    except OSError as exc:
        raise _local(exc, "could not write a temporary copy") from None
    with out, _opener(test).open(req, timeout=TIMEOUT_S) as resp:
        got = 0
        while True:
            chunk = resp.read(CHUNK)
            if not chunk:
                break
            got += len(chunk)
            if got > size:
                raise _Failure("the download was larger than announced")
            h.update(chunk)
            try:
                out.write(chunk)
            except OSError as exc:
                raise _local(exc, "could not write a temporary copy") from None
    if got != size:
        raise _Failure("the download was incomplete")
    digest[:] = [h.hexdigest()]


def _drop_unused_plans(files: dict, planned: set, claimed: set) -> None:
    """Creates planned this run that never started need no record."""
    for k in planned:
        rec = files.get(k)
        if (isinstance(rec, dict) and isinstance(rec.get("pending"), dict)
                and relpath_key(k) not in claimed):
            del files[k]


def ack_saved(origin: str, raw: str, dest: str, test: bool) -> None:
    """Tell Frontier the files are in the user's folder: only the task folder's own name (its
    basename), never a path. Best effort and silent: the files are saved either way."""
    name = os.path.basename(os.path.normpath(dest))
    if not name:
        return
    try:
        ticket_call(origin, raw, "POST", "/saved", {"dir": name}, test)
    except Exception:  # noqa: BLE001 - an acknowledgement never changes the outcome
        pass


def fetch(args: argparse.Namespace) -> int:
    origin, raw = parse_ticket(args.ticket, args.base)
    test = args.base is not None
    to = args.to
    if not os.path.isdir(to):
        raise UsageError(f"{to} is not a folder")
    resp = ticket_call(origin, raw, "GET", "/files", None, test)
    listed = resp.get("files") if isinstance(resp.get("files"), list) else []
    task_id = resp.get("task_id") if isinstance(resp.get("task_id"), str) else ""
    base_name = dir_name(resp.get("suggested_dir"), task_id)

    failed: list[str] = []
    jobs: list[tuple[str, str, int, list[str]]] = []  # rel, url, size, local segments
    for f in listed:
        path = f.get("path") if isinstance(f, dict) else None
        label = path if isinstance(path, str) else "?"
        try:
            rel = safe_relpath(path)  # type: ignore[arg-type]
            if relpath_key(rel) == MARKER:
                raise _Failure(f"{MARKER} is the helper's own file")
            size = f.get("size")
            if not isinstance(size, int) or isinstance(size, bool) or size < 0:
                raise _Failure("bad size")
            if not link_ok(f.get("url"), test):
                raise _Failure("the download link is not https")
        except (ValueError, _Failure) as exc:
            failed.append(label)
            print(f"Could not save {label}: {_clean(exc, 80)}", file=sys.stderr)
            continue
        jobs.append((rel, f["url"], size, [local_segment(s) for s in rel.split("/")]))

    counts = {"added": 0, "updated": 0, "unchanged": 0}
    kept_both: list[str] = []
    partial: list[str] = []
    net_failed = 0
    hosts: set[str] = set()
    dest: str | None = None
    files: dict = {}
    prior: set = set()
    planned: set = set()
    claimed: set = set()
    interrupted: list[str] = []
    tmp_dir = tempfile.mkdtemp(prefix="frontier-")  # private, outside --to
    tmp = os.path.join(tmp_dir, "download")
    try:
        # One file at a time: the temp folder never holds more than the file in hand.
        for i, (rel, url, size, segs) in enumerate(jobs):
            digest: list = []
            reason, host = _with_retry(url, _get_once, url, tmp, size, test, digest)
            try:
                if reason is not None:
                    failed.append(rel)
                    if host:
                        hosts.add(host)
                        net_failed += 1
                    print(f"Could not save {rel}: {reason}", file=sys.stderr)
                    continue
                if dest is None:
                    dest, files = find_dest(to, base_name, task_id)
                    prior = set(files)  # records from earlier runs
                    # One marker write before the run's first write, covering all of them.
                    for job in jobs[i:]:
                        k = _plan(dest, job[3], files, prior)
                        if k is not None:
                            planned.add(k)
                    if not write_marker(dest, task_id, files):
                        raise FrontierError(f"could not write {MARKER} in {dest}; nothing was "
                                            "saved there")
                parent = _make_dirs(dest, segs[:-1])
                if not _inside(parent, os.path.realpath(dest)):
                    raise _Failure("outside the destination")
                outcome, written = _merge(
                    parent, "/".join(segs[:-1]), segs[-1], tmp, size, digest[0], files,
                    lambda: write_marker(dest, task_id, files, sync=False), claimed, prior,
                    interrupted)
            except _Partial as exc:
                failed.append(rel)
                partial.append(str(exc))
                print(f"Could not finish writing {rel}: {exc} is partly written. Fetching again "
                      "keeps it and saves the complete version alongside it.", file=sys.stderr)
                continue
            except (_Failure, OSError) as exc:
                failed.append(rel)
                print(f"Could not save {rel}: {_clean(exc, 80)}", file=sys.stderr)
                continue
            finally:
                try:
                    os.unlink(tmp)  # our own private temp copy, never the destination
                except OSError:
                    pass
            if outcome == "kept_both":
                kept_both.append(written)
            else:
                counts[outcome] += 1
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        if dest is not None:
            _drop_unused_plans(files, planned, claimed)
        if dest is not None and not write_marker(dest, task_id, files):  # last
            print(f"Could not update {MARKER} in {dest}; the next fetch may save copies "
                  "alongside instead of updating files.", file=sys.stderr)

    shown = dest or os.path.join(to, base_name)
    written = counts["added"] + counts["updated"] + len(kept_both)
    # Only a complete fetch says "saved": every listed file is in place (new versions kept
    # alongside count), none failed, none was cut off now or left cut off from before.
    if (dest is not None and written + counts["unchanged"] > 0 and not failed and not partial
            and not interrupted):
        ack_saved(origin, raw, dest, test)
    if not listed:
        print("Frontier has not delivered any files for this task yet.", file=sys.stderr)
    else:
        print(f"Saved to {shown}: {counts['added']} added, {counts['updated']} updated, "
              f"{counts['unchanged']} unchanged.", file=sys.stderr)
    if kept_both:
        print(f"{len(kept_both)} files had been changed since Frontier delivered them (or were "
              "not Frontier's); those copies were kept and the new versions saved alongside: "
              + ", ".join(kept_both), file=sys.stderr)
    if hosts:
        print(net_hint(hosts), file=sys.stderr)
    out = {"saved_to": shown, "files": written, **counts, "kept_both": kept_both,
           "failed": failed}
    if partial:
        out["partial"] = partial
    if interrupted:
        out["interrupted"] = interrupted
        print(f"An earlier save of {', '.join(interrupted)} was cut off. Those files were kept "
              "as they are; the complete versions are the copies saved alongside. The cut-off "
              "files can be deleted.", file=sys.stderr)
    print(json.dumps(out))
    if failed and written + counts["unchanged"] == 0 and net_failed == len(failed):
        return 1
    return 3 if failed else 0


# --- command line ----------------------------------------------------------------------------

def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="frontier.py", description="Move files to and from a "
                                "Frontier task using a ticket link from a Frontier tool result.")
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("stage", help="upload a folder (or listed paths in it) to a task")
    s.add_argument("--ticket", required=True, help="ticket_url from frontier_request_upload, or - to read it from stdin")
    s.add_argument("--root", required=True, help="the folder to upload from")
    s.add_argument("paths", nargs="*", help="only these files or subfolders (inside --root)")
    s.add_argument("--base", help=argparse.SUPPRESS)
    g = sub.add_parser("fetch", help="download a task's delivered files")
    g.add_argument("--ticket", required=True, help="ticket_url from frontier_request_download, or - to read it from stdin")
    g.add_argument("--to", required=True, help="the folder to save into")
    g.add_argument("--base", help=argparse.SUPPRESS)
    return p


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0) if not isinstance(exc.code, str) else 2
    try:
        if args.ticket == "-":
            args.ticket = sys.stdin.readline().strip()
        return stage(args) if args.cmd == "stage" else fetch(args)
    except UsageError as exc:
        print(f"frontier: {exc}", file=sys.stderr)
        return 2
    except FrontierError as exc:
        print(f"frontier: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"frontier: {exc.strerror or 'file error'}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("frontier: stopped", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
