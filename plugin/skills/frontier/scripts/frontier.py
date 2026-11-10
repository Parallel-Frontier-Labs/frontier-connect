#!/usr/bin/env python3
"""Frontier plugin helper: move a local folder up to a Frontier task, and bring the task's
delivered files back down. Python 3 standard library only.

    python3 frontier.py stage --ticket <ticket_url> [--root <folder>]... [--add <file>]... [<path> ...]
    python3 frontier.py fetch --ticket <ticket_url> --to <folder>

The ticket URL comes from a Frontier tool result (frontier_request_upload or
frontier_request_download). Its secret part is the URL fragment: this helper sends it only in an
`Authorization: Ticket ...` header to api.parallelfrontier.io, never in a path or query, and never
prints or logs it. The helper stores no credentials. File bytes travel over the short-lived
presigned https links Frontier hands back, which must be https and are never followed through
redirects. The helper reads only inside the --root folders and the --add files, and writes only inside --to.

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
import base64
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
LIST_MAX = 20_000  # files listed per task (names, folders, sizes only)
LIST_PAGE = 5_000  # entries per /t/list post
LIST_PAGE_BYTES = 3 * 1024 * 1024  # and at most this much JSON per post (the server takes 4 MiB)
MAX_FILES = 1000  # an older backend's /t/manifest cap (fallback only)
MAX_ROOTS = 64  # folders per stage (the server reads at most 64 identities per listing)
MAX_TOTAL_BYTES = 2 * 1024 ** 3
ATTACHED = "attached"
DONE_TIMEOUT_S = 180  # /t/list/done shortlists up to 20,000 files before it answers
WORKERS = 4
TIMEOUT_S = 60
MAX_JSON_BYTES = 32 * 1024 * 1024
CHUNK = 1024 * 1024
USER_AGENT = "frontier-plugin/0.2.9"
DEFAULT_MIME = "application/octet-stream"

EXPIRED = ("This Frontier link has expired or was already used. Ask the assistant to request a "
           "new one and try again.")
RATE_LIMITED = "Frontier is rate limiting these requests. Wait a minute, then ask again."
BUSY = ("An earlier stage on this ticket is still being finished. Wait up to 5 minutes for it to "
        "end, then get a new ticket (frontier_request_upload with the same task_id) and run the "
        "same stage again: the files are listed and sent again.")
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
# Frontier's network edge (in front of api.parallelfrontier.io) refused the request before it reached
# Frontier: the account is fine, so this must never read as an account problem.
EDGE_BLOCKED = "Frontier couldn't take this request from here."
RESERVED_TOP_FILES = frozenset({"folder-index.md", "context.md"})


def _proxy_refused(exc: BaseException) -> int | None:
    """The proxy's status when it refused the tunnel (CONNECT answered 403 or 407): a policy denial
    of the host, not a flaky connection. None otherwise."""
    text = f"{exc} {getattr(exc, 'reason', '')}"
    for status in (403, 407):
        if f"Tunnel connection failed: {status}" in text:
            return status
    return None


_EDGE_JSON = re.compile(rb'"error_code"\s*:\s*(\d{4})\b')
_EDGE_TEXT = re.compile(rb"\Aerror code: (\d{4})\s*\Z", re.IGNORECASE)


def _edge_code(body: bytes) -> int | None:
    """The edge's 1xxx code when the body is the network edge's own block page (plain text, or JSON
    with a 4-digit error_code and an error_name), else None. Frontier's own refusals are
    {"detail": ...} and never match."""
    m = _EDGE_TEXT.match(body.strip())
    if m is None and b'"error_name"' in body:
        m = _EDGE_JSON.search(body)
    return int(m.group(1)) if m else None


def _kind(exc: BaseException) -> str:
    """A fixed, short name for a network failure: the exception class, never its text."""
    reason = getattr(exc, "reason", None)
    name = type(reason if isinstance(reason, BaseException) else exc).__name__
    return name if re.fullmatch(r"[A-Za-z]{1,40}", name) else "error"


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
    """Frontier or the network refused: exit 1. `status` is the HTTP status when Frontier answered.
    `diagnostic` is for the assistant only (printed as JSON on stdout, never shown to the user):
    fixed codes and numbers, never a URL, header, ticket or response text."""

    def __init__(self, message: str = "", status: int | None = None,
                 diagnostic: dict | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.diagnostic = diagnostic


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
        raise FrontierError("Frontier's answer was too large", diagnostic={"stage": "too_large"})
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


def _detail(body: bytes) -> str:
    try:
        d = json.loads(body).get("detail")
    except Exception:  # noqa: BLE001 - the detail is optional
        return ""
    return d if isinstance(d, str) else ""


def ticket_call(origin: str, raw: str, method: str, sub: str, body: dict | None, test: bool,
                timeout: float = TIMEOUT_S) -> dict:
    """One call to the ticket endpoint; the secret travels only in the Authorization header."""
    headers = {"Authorization": f"Ticket {raw}", "Accept": "application/json",
               "User-Agent": USER_AGENT}
    data = None
    if body is not None:
        # UTF-8, not \\uXXXX escapes: a CJK name costs 3 bytes, not 6 (list_pages measures this).
        # safe_relpath refuses a lone surrogate (it cannot be encoded), so this never fails.
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(origin + TICKET_PATH + sub, data=data, method=method,
                                 headers=headers)
    try:
        with _opener(test).open(req, timeout=timeout) as resp:
            return _read_json(resp)
    except urllib.error.HTTPError as exc:
        code = exc.code
        diag: dict = {"stage": "http", "status": code}
        detail = ""
        body = b""
        if code in (400, 401, 403, 404, 409):
            try:
                body = exc.read(64 * 1024)
            except Exception:  # noqa: BLE001 - the body is optional
                body = b""
        if code in (400, 409):
            try:
                detail = _clean(json.loads(body).get("detail", ""))
            except Exception:  # noqa: BLE001 - the detail is optional
                detail = ""
        exc.close()
        edge = _edge_code(body) if code in (401, 403) else None
        if edge is not None:
            raise FrontierError(EDGE_BLOCKED, status=code,
                                diagnostic={**diag, "edge": "network", "code": edge}) from None
        if code == 404 and _detail(body) == "Not Found":  # the server's own 404: no such route here
            raise FrontierError(EXPIRED, status=404, diagnostic={**diag, "route": "missing"}) from None
        if code == 404:
            raise FrontierError(EXPIRED, diagnostic=diag) from None
        if code == 429:
            raise FrontierError(RATE_LIMITED, diagnostic=diag) from None
        if code == 400:
            raise FrontierError(f"Frontier refused the request: {detail or 'bad request'}",
                                status=400, diagnostic=diag) from None
        if code == 402:  # the paid check: waiting will not fix it
            raise FrontierError(PLAN_INACTIVE, diagnostic=diag) from None
        if code in (401, 403):
            raise FrontierError(NO_ACCESS, diagnostic=diag) from None
        if code >= 500:
            raise FrontierError(f"Frontier answered HTTP {code}; try again in a moment",
                                diagnostic=diag) from None
        if code == 409 and "being finished" in detail:
            raise FrontierError(BUSY, status=409, diagnostic=diag) from None
        if code == 409 and detail:
            raise FrontierError(f"Frontier refused the request (HTTP 409): {detail}",
                                status=409, diagnostic=diag) from None
        raise FrontierError(f"Frontier refused the request (HTTP {code}).", diagnostic=diag) from None
    except (urllib.error.URLError, http.client.HTTPException, OSError, socket.timeout) as exc:
        refused = _proxy_refused(exc)
        if _host(origin) == API_HOST and refused:
            raise FrontierError(NETWORK_BLOCKED,
                                diagnostic={"stage": "proxy_connect", "status": refused}) from None
        raise FrontierError(net_hint({_host(origin)}),
                            diagnostic={"stage": "network", "kind": _kind(exc)}) from None


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
    added: bool = False  # --add (under attached/); a named file inside a root is not
    given: str = ""  # an added file's own name, made safe (what it goes up as unless taken)

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


class _Full(Exception):
    """The walk reached its limit."""


def walk(root: Path, paths: list[str], limit: int | None = None) -> list[Local]:
    """The files to offer under `root`: every visible regular file, or only the listed paths
    (files, or folders walked the same way). A listed FILE is flagged explicit (always sent); the
    files under a listed FOLDER are not: the folder only narrows the listing and Frontier picks
    inside it. Skips hidden files and folders, Office lock files (~$*), .DS_Store, Thumbs.db,
    symlinked folders and links that leave the folder. Every listed path is checked before the
    walk starts: UsageError for one outside `root` or missing, even past the limit. With `limit`,
    stops early on a huge folder and returns what it found (every named file, and at most
    `limit + 1` others: named files never count against the limit)."""
    root_abs = os.path.abspath(str(root))
    root_real = os.path.realpath(root_abs)
    found: dict[str, Local] = {}
    judged = [0]  # files found that are not named (only those count against `limit`)

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
        if rel in found:
            return
        found[rel] = Local(rel, full, st.st_size, explicit, st.st_dev, st.st_ino)
        judged[0] += not explicit
        if limit is not None and judged[0] > limit:
            raise _Full

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

    named: list[str] = []
    for p in paths:
        full = os.path.abspath(p if os.path.isabs(p) else os.path.join(root_abs, p))
        lexical_ok = full == root_abs or full.startswith(root_abs.rstrip(os.sep) + os.sep)
        if not lexical_ok or not _inside(full, root_real):
            raise UsageError(f"{p} is not inside {root}")
        if not os.path.lexists(full):
            raise UsageError(f"{p} does not exist")
        named.append(full)
    try:
        if not paths:
            walk_dir(root_abs, False)
        for full in named:  # named files first: explicit even when a named folder holds them too
            if not os.path.isdir(full):
                add(full, True)
        for full in named:
            if os.path.isdir(full):  # a link to a folder inside root counts, it was checked above
                walk_dir(full, False)
    except _Full:
        pass
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


def _numbered(name: str, n: int) -> str:
    stem, dot, ext = name.rpartition(".")
    return f"{stem} ({n}).{ext}" if dot and stem else f"{name} ({n})"


def _usable_name(name: str, fallback: str = "file") -> str:
    """A name made usable on every system, for an attached file or a root folder's top (both are
    always sent, so the name is fixed, never refused): control, format and separator characters
    dropped, slashes replaced, trailing dots and spaces stripped ("Acme Inc." -> "Acme Inc"), a
    Windows device stem prefixed with `_` (`_CON.pdf`), cut to MAX_SEGMENT_BYTES keeping the
    extension; `fallback` when nothing usable is left."""
    name = "".join(c for c in unicodedata.normalize("NFC", name)
                   if unicodedata.category(c) not in _BAD_CATEGORIES)
    name = name.replace("/", "_").replace("\\", "_").rstrip(". ") or fallback
    if name.split(".", 1)[0].strip().upper() in _WINDOWS_DEVICES:
        name = "_" + name
    if len(name.encode("utf-8")) > MAX_SEGMENT_BYTES:
        stem, dot, ext = name.rpartition(".")
        ext = f".{ext}" if dot and stem and len(ext.encode()) <= MAX_EXT_BYTES else ""
        stem = name[: len(name) - len(ext)] if ext else name
        name = _cut(stem, MAX_SEGMENT_BYTES - len(ext.encode())).rstrip(". ") + ext
    try:
        safe_relpath(f"{ATTACHED}/{name}")
    except ValueError:
        return fallback
    return name


def _attach_name(folder: str, name: str, size: int, names: set[str],
                 task: dict[str, tuple[int, str]]) -> str:
    """The name an added file gets under `folder`: same name and same size as a file the task
    already holds is the same file, sent again in place; a different file of that name (another
    size) gets the next free `name (2).ext`, `(3)`... skipping names this run or the task already
    use for something else. `task` is the task's folder state by key: (size, status). A row
    that holds nothing (not `issued` nor a direct upload, `uploaded`) is free to take over."""
    n, cand = 1, name
    while True:
        key = relpath_key(f"{folder}/{cand}")
        held = task.get(key)
        if key not in names and (held is None or held[1] not in ("issued", "uploaded")
                                 or held[0] == size):
            names.add(key)
            return cand
        n += 1
        cand = _numbered(name, n)


def collect(roots: list[str], adds: list[str], paths: list[str], limit: int,
            task: TaskState | None = None,
            ids: dict[str, str] | None = None) -> tuple[list[Local], bool]:
    """Every file to list: each --add first (explicit, under attached/), then each root, always
    under its folder's name (owner decision D3: `2024/statement.pdf`, never `statement.pdf`), so
    two different folders sent to one task never share a path and a re-run keeps the same ones.
    `attached` is the attachments' own folder: a root of that name goes up as `attached (2)`,
    two roots of one name as `name` and `name (2)`. Returns (files, stopped): stopped when the folders
    held more than `limit` files for Frontier to judge, which are then cut at `limit`. Files
    named or added are always kept and never count against `limit`. `task` (the task's folder
    state, from GET /t/files) names each --add file (_attach_name) and each root (_root_top):
    roots go in order of their real paths, so the order they are given in never swaps the
    numbered names. `ids` gets {top: identity} for this run's roots when the task has a salt."""
    if paths and len(roots) != 1:
        raise UsageError("paths after the options need exactly one --root; use --add for files outside it")
    if len(roots) > MAX_ROOTS:
        raise UsageError(f"at most {MAX_ROOTS} folders in one stage; send the others in another "
                         "stage, with a new ticket for the same task")
    for r in roots:
        if not Path(r).is_dir():
            raise UsageError(f"{r} is not a folder")
    task = task or TaskState({}, {})
    tops: set[str] = {relpath_key(ATTACHED)}
    walked: list[Local] = []
    for r in sorted(roots, key=lambda x: os.path.realpath(x)):
        listed = walk(Path(r), paths, limit=limit)
        # NFC first: a name stored decomposed (older Mac disks, zips) is the same name, not a
        # rename; _usable_name normalises the same way.
        raw = unicodedata.normalize("NFC", local_segment(Path(r).resolve().name))
        name = _usable_name(raw, "folder")
        rid = root_identity(task.salt, r) if task.salt else None
        top = _root_top(name, rid, tops, task)
        if top != raw:
            why = ("another folder of that name is already there" if name == raw
                   else "its name is not usable on every system")
            print(f"{r} went up as {top}: {why}.", file=sys.stderr)
        if rid is not None and ids is not None:
            ids[top] = rid
        for f in listed:
            f.rel = f"{top}/{f.rel}"
        walked += listed
    files: list[Local] = []
    if adds:
        folder = ATTACHED
        names: set[str] = set()
        for a in adds:
            try:
                st = os.lstat(a)
            except OSError:
                raise UsageError(f"{a} does not exist") from None
            if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
                raise UsageError(f"{a} is not a regular file (no folders or links with --add)")
            given = _usable_name(os.path.basename(a))
            name = _attach_name(folder, given, st.st_size, names, task.files)
            files.append(Local(f"{folder}/{name}", os.path.abspath(a), st.st_size, True,
                               st.st_dev, st.st_ino, added=True, given=given))
    judged = 0
    for f in walked:
        if not f.explicit:
            judged += 1
            if judged > limit:
                continue
        files.append(f)
    return files, judged > limit


def list_pages(entries: list[dict]):
    """The /t/list pages: each closes at LIST_PAGE entries or LIST_PAGE_BYTES of the JSON body
    ticket_call sends (UTF-8, ensure_ascii=False), whichever comes first. A page always holds at
    least one entry."""
    room = LIST_PAGE_BYTES - len(json.dumps({"page": 1000, "files": []}, ensure_ascii=False).encode())
    page: list[dict] = []
    used = 0
    for e in entries:
        n = len(json.dumps(e, ensure_ascii=False).encode()) + 2  # ", " between entries
        if page and (len(page) >= LIST_PAGE or used + n > room):
            yield page
            page, used = [], 0
        page.append(e)
        used += n
    if page:
        yield page


@dataclass
class TaskState:
    """What the task already holds (GET /t/files on the upload ticket): files by key (size,
    status), the identity each top folder is bound to (`tops`, by key), and the task's random
    salt for this run's folder identities, made by the server (None: an older backend; no
    identities are sent)."""

    files: dict[str, tuple[int, str]]
    tops: dict[str, str]
    salt: str | None = None
    task_id: str | None = None


_ID = re.compile(r"[A-Za-z0-9_-]{16,64}")


def task_files(origin: str, raw: str, test: bool) -> TaskState:
    """The task's folder state. Empty from a backend without the route; anything unusable in the
    answer is left out."""
    try:
        resp = ticket_call(origin, raw, "GET", "/files", None, test)
    except FrontierError as exc:
        diag = exc.diagnostic or {}
        if diag.get("route") == "missing" or diag.get("stage") == "too_large":
            # No state to name by: the server still refuses to overwrite another file or folder.
            return TaskState({}, {})
        raise
    resp = resp if isinstance(resp, dict) else {}
    out: dict[str, tuple[int, str]] = {}
    rows = resp.get("files")
    for r in rows if isinstance(rows, list) else []:
        if (isinstance(r, dict) and isinstance(r.get("path"), str) and type(r.get("size")) is int
                and isinstance(r.get("status"), str)):
            out[relpath_key(r["path"])] = (r["size"], r["status"])
    tops_in = resp.get("tops")
    tops = {relpath_key(k): v for k, v in (tops_in.items() if isinstance(tops_in, dict) else [])
            if isinstance(k, str) and isinstance(v, str) and _ID.fullmatch(v)}
    salt, tid = resp.get("salt"), resp.get("task_id")
    return TaskState(out, tops, salt if isinstance(salt, str) and _ID.fullmatch(salt) else None,
                     tid if isinstance(tid, str) and tid else None)


def _identity_path(folder: str) -> str:
    """What a folder's identity hashes: its real path, or for a folder under a session mount
    (Cowork and cloud sessions mount connected folders at .../mnt/<name>) only the part from the
    last `mnt` segment on, so the same connected folder matches across sessions, whose mount
    roots differ (owner decision 2026-11-09). The trade-off: two different folders of the same
    name connected in different sessions count as the same folder. Native paths (macOS,
    Windows) keep the full real path."""
    real = os.path.realpath(folder)
    parts = Path(real).parts
    marks = [i for i, p in enumerate(parts[:-1]) if p == "mnt"]
    return "/".join(parts[marks[-1]:]) if marks else real


def root_identity(salt: str, folder: str) -> str:
    """A folder's private identity in one task (owner decision 2026-11-09, review Q1-c): a
    SHA-256 of the folder's real path salted with the task's random salt (16 bytes the server
    makes per task and hands only to ticket holders), cut to 22 URL-safe characters. The path is
    never sent, and a guessed path cannot be checked against an identity without the salt; the
    same folder has unrelated ids in two tasks. The same folder on the same machine gets the same id (a re-run goes in place); a
    moved or renamed folder gets another one, so it goes up alongside as "name (2)"."""
    digest = hashlib.sha256(b"frontier-root\0" + salt.encode() + b"\0"
                            + os.fsencode(_identity_path(folder))).digest()
    return base64.urlsafe_b64encode(digest).decode()[:22]


def _root_top(name: str, rid: str | None, used: set[str], task: TaskState) -> str:
    """The top folder a root goes under: its name, or the first free "name (2)", "(3)"...: not
    used in this run (nor `attached`), and in the task either not there, there with no identity
    (an older plugin or the card: the same folder, as before), or bound to this root's id. A top
    the task holds only as direct uploads (no folder ever went there) is another folder's."""
    n, cand = 1, name
    while True:
        key = relpath_key(cand)
        bound = task.tops.get(key)
        under = [st for k, (_sz, st) in task.files.items() if k.startswith(key + "/")]
        direct_only = bool(under) and all(st == "uploaded" for st in under)
        if key not in used and not direct_only and (rid is None or bound is None or bound == rid):
            used.add(key)
            return cand
        n += 1
        cand = f"{name} ({n})"


def _manifest(origin: str, raw: str, entries: list[dict], test: bool) -> dict:
    entries = [{k: v for k, v in e.items() if k != "replace"} for e in entries]  # /t/list only
    try:
        return ticket_call(origin, raw, "POST", "/manifest", {"files": entries, "multipart": True}, test)
    except FrontierError as exc:
        if exc.status != 400:
            raise
        # A backend from before multipart rejects the unknown field before it uses the ticket:
        # ask once more without it and every file gets a single put_url.
        return ticket_call(origin, raw, "POST", "/manifest", {"files": entries}, test)


def stage(args: argparse.Namespace) -> int:
    origin, raw = parse_ticket(args.ticket, args.base)
    test = args.base is not None
    if not (args.root or args.add):
        raise UsageError("give --root <folder> or --add <file>")
    # An added file needs the task's state to keep a different file of the same name apart
    # (one of the ticket's requests, spent only when there are --add files).
    # What the task holds: keeps another attachment or another folder of a taken name apart
    # (one of the ticket's requests).
    task = task_files(origin, raw, test)
    ids: dict[str, str] = {}
    listed, stopped = collect(args.root or [], args.add or [], args.paths, LIST_MAX, task, ids)
    for f in listed:
        own = unicodedata.normalize("NFC", os.path.basename(f.abs))
        if f.added and f.rel.rsplit("/", 1)[-1] != own:
            why = ("another file of that name is already there" if f.given == own
                   else "its name is not usable on every system")
            print(f"{own} went up as {f.rel}: {why}.", file=sys.stderr)
    files: list[Local] = []
    not_sent: list[str] = []
    keys: set[str] = set()
    reserved: list[str] = []
    unusable_named: list[str] = []  # files the user named whose path cannot be sent: failures
    why_named: dict[str, str] = {}
    kept: dict[str, Local] = {}
    for f in listed:
        try:
            f.rel = safe_relpath(f.rel)
        except ValueError:
            not_sent.append(f.rel)
            if f.explicit:
                unusable_named.append(f.rel)
            continue
        if relpath_key(f.rel) in RESERVED_TOP_FILES:
            reserved.append(f.rel)
            not_sent.append(f.rel)
            continue
        if relpath_key(f.rel) in keys:
            other = kept[relpath_key(f.rel)]
            same = (other.dev, other.ino) == (f.dev, f.ino) if f.ino else \
                os.path.realpath(other.abs) == os.path.realpath(f.abs)
            if f.explicit and not same:
                # Two different files the user named differ only in case or accents (a
                # case-sensitive file system): one key on the task, so the second is a failure,
                # never a silent drop. Two spellings of one file on disk (case-insensitive macOS,
                # NFC/NFD) are the same file: the second is dropped, harmlessly.
                unusable_named.append(f.rel)
                why_named[f.rel] = "another named file has the same name ignoring case"
            else:
                not_sent.append(f.rel)
            continue
        keys.add(relpath_key(f.rel))
        kept[relpath_key(f.rel)] = f
        files.append(f)
    if reserved:
        print(f"Not sent: {', '.join(reserved)}. Frontier writes context.md and folder-index.md "
              "at the top of a task's folder itself; rename these to send them.", file=sys.stderr)
    for rel in unusable_named:
        why = why_named.get(rel, "its name is not usable on every system")
        print(f"Could not upload {rel}: {why}; ask the user to rename it", file=sys.stderr)
    # Identities only for usable tops that have files going up (the server reads the rest as the
    # same folder anyway; an empty folder's top must never bind a name it does not use).
    sent_tops = {relpath_key(f.rel.split("/", 1)[0]) for f in files if "/" in f.rel}
    ids = {t: v for t, v in ids.items() if relpath_key(t) in sent_tops}
    if not files and unusable_named:  # nothing else to send: report, never list nothing
        print(json.dumps({"task_id": task.task_id, "uploaded": 0, "attached": 0, "listed": 0,
                          "skipped": 0, "failed": unusable_named, "listing_stopped": stopped,
                          "explicit_failed": unusable_named, "not_sent": not_sent}))
        print("Next: ask the user to rename these files, then stage them again.", file=sys.stderr)
        return 3
    if not files:
        raise UsageError("there are no files to upload in that folder")
    # A file named inside a folder is the same file at the same path: when it changed since an
    # earlier run, it replaces that upload (`replace`). An added file never does: another file of
    # the same name got its own name above, and the server refuses a silent replacement.
    entries = [{"path": f.rel, "size": f.size, "mime": f.mime,
                **({"explicit": True} if f.explicit else {}),
                **({"replace": True} if f.explicit and not f.added else {})}
               for f in files]
    if stopped:
        print(f"This folder holds more than {LIST_MAX} files; Frontier listed the first {LIST_MAX}. "
              "Ask the user which subfolders matter if the work needs others.", file=sys.stderr)
    print(f"Listing {len(files)} files for Frontier...", file=sys.stderr)
    left_out: list[tuple[str, str]] = []  # files Frontier left out of the listing, with why
    try:
        for n, page in enumerate(list_pages(entries), 1):
            listed_ans = ticket_call(origin, raw, "POST", "/list",
                                     {"page": n, "files": page, **({"roots": ids} if ids else {})},
                                     test)
            for x in listed_ans.get("not_sent") or [] if isinstance(listed_ans, dict) else []:
                if isinstance(x, dict) and isinstance(x.get("path"), str):
                    left_out.append((x["path"], _clean(x.get("reason")) or "not sent"))
        resp = ticket_call(origin, raw, "POST", "/list/done", {"multipart": True}, test,
                           timeout=DONE_TIMEOUT_S)
    except FrontierError as exc:
        if (exc.diagnostic or {}).get("route") != "missing":
            raise
        if args.add or len(args.root or []) > 1 or len(files) > MAX_FILES or \
                sum(f.size for f in files) > MAX_TOTAL_BYTES:
            raise FrontierError("Frontier needs an update to take these files this way. Send one "
                                f"folder of at most {MAX_FILES} files and 2 GiB, or try again later.") from None
        resp = _manifest(origin, raw, entries, test)
    # By key: a row the task already holds keeps its stored spelling (another case, or the
    # spelling an open multipart upload was made from), and its link is still this file's.
    by_key = {relpath_key(f.rel): f for f in files}
    uploads = resp.get("uploads") if isinstance(resp.get("uploads"), list) else []
    sk = resp.get("skipped")
    n_skipped = sk if isinstance(sk, int) and not isinstance(sk, bool) else len(sk) if isinstance(sk, list) else 0
    failed: list[str] = list(unusable_named)
    bad_plans: list[str] = []  # an open upload server-side whose plan we cannot use: abort it
    singles: list[tuple[Local, dict]] = []
    multis: dict[str, tuple[Local, dict, list]] = {}
    seen: set[str] = set()
    for up in uploads:
        path = up.get("path") if isinstance(up, dict) else None
        item = by_key.get(relpath_key(path)) if isinstance(path, str) else None
        if item is None:
            # Not a file this run listed (the backend scopes done to this ticket, so this should
            # not happen): never PUT it, and never count it as this run's failure.
            continue
        path = item.rel  # this run's own spelling from here on
        if path in seen:
            failed.append(path)
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
    linked = seen | set(failed)
    for f in files:  # a named or added file is always sent: no link for it is a failure
        if f.explicit and f.rel not in linked:
            failed.append(f.rel)
            print(f"Could not upload {f.rel}: Frontier sent no upload link for it", file=sys.stderr)
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
            completed = {relpath_key(p) for p in done_l if isinstance(p, str)}
            told = {relpath_key(f["path"]): _clean(f.get("reason")) for f in fail_l
                    if isinstance(f, dict) and isinstance(f.get("path"), str)}
            for r in done:  # Frontier answers with the spelling the task's row keeps
                if relpath_key(r) not in completed:
                    reasons[r] = told.get(relpath_key(r)) or "Frontier could not finish the upload"
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
    out: dict = {"task_id": resp.get("task_id"), "uploaded": uploaded,
                 "attached": sum(1 for f in files if f.explicit and f.rel.split("/", 1)[0].startswith(ATTACHED)
                                 and f.rel not in failed),
                 "listed": len(files), "skipped": n_skipped, "failed": failed,
                 "listing_stopped": stopped}
    named_failed = unusable_named + [f.rel for f in files if f.explicit and f.rel in failed]
    if named_failed:
        out["explicit_failed"] = named_failed
    for rel, why in left_out:
        print(f"Not sent: {rel} ({why})", file=sys.stderr)
    if not_sent or left_out:
        out["not_sent"] = not_sent + [rel for rel, _why in left_out]
        if len(not_sent) > len(reserved):
            print(f"{len(not_sent) - len(reserved)} files were not sent: their names are not usable "
                  "on every system.", file=sys.stderr)
    if hosts:
        print(net_hint(hosts), file=sys.stderr)
    # /list/done says whether the task already exists (a follow-up); /manifest never does.
    nxt = (f"frontier_continue_task for {out['task_id']}" if resp.get("existing") is True
           else f"frontier_start_task with upload_id {out['task_id']}")
    if named_failed or (failed and uploaded == 0):
        # A file the user named or attached (or everything) did not go up: the task must not
        # run without it. Retry those files with a new ticket before the next step.
        nxt = (f"frontier_request_upload with task_id {out['task_id']} for a new ticket, then "
               f"stage only the files that failed again; call {nxt} only when they are in, or "
               "ask the user")
    print(f"Files in: {uploaded} sent ({out['attached']} attached), {n_skipped} listed for Frontier "
          f"to ask for. Next: {nxt}.", file=sys.stderr)
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
    s = sub.add_parser("stage", help="upload folders and attached files to a task")
    s.add_argument("--ticket", required=True, help="ticket_url from frontier_request_upload, or - to read it from stdin")
    s.add_argument("--root", action="append", help="a folder to upload from (repeat for several)")
    s.add_argument("--add", action="append", help="a single file from anywhere, always sent (repeat)")
    s.add_argument("paths", nargs="*", help="only these files or subfolders (inside a single --root)")
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
        if exc.diagnostic:
            print(json.dumps({"diagnostic": exc.diagnostic}))
        return 1
    except OSError as exc:
        print(f"frontier: {exc.strerror or 'file error'}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("frontier: stopped", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
