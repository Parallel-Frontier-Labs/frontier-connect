#!/usr/bin/env python3
"""Build the Frontier plugin for Microsoft Copilot (Cowork) as dist/frontier-copilot.zip.

Copilot takes a Microsoft 365 app package, not a Claude/Codex plugin: manifest.json, two icons, a
tool description file per MCP connector and the skills, all at the zip's root (no wrapper folder).
The skill is the same `frontier` skill the Claude and Codex plugin ships (plugin/skills/frontier),
so there is one copy of it. The build is deterministic: same inputs, same bytes.

Run: python3 scripts/build_copilot.py [--out PATH]
"""
from __future__ import annotations

import argparse
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "copilot"
SKILL = ROOT / "plugin" / "skills" / "frontier"
DEFAULT_OUT = ROOT / "dist" / "frontier-copilot.zip"
_EPOCH = (1980, 1, 1, 0, 0, 0)  # fixed timestamp: the zip's bytes depend on its contents only


def entries() -> list[tuple[str, Path]]:
    """(name in the zip, source file), sorted. Skips caches and hidden files."""
    out = [("manifest.json", SRC / "manifest.json"), ("color.png", SRC / "color.png"),
           ("outline.png", SRC / "outline.png")]
    out += [(f"tools/{p.name}", p) for p in sorted((SRC / "tools").glob("*.json"))]
    for p in sorted(SKILL.rglob("*")):
        rel = p.relative_to(SKILL)
        if p.is_file() and "__pycache__" not in rel.parts and not any(s.startswith(".") for s in rel.parts):
            out.append((f"skills/frontier/{rel.as_posix()}", p))
    return sorted(out)


def build(out: Path = DEFAULT_OUT) -> Path:
    manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    plugin = json.loads((ROOT / "plugin" / ".claude-plugin" / "plugin.json").read_text(encoding="utf-8"))
    if manifest["version"] != plugin["version"]:
        raise SystemExit(f"copilot/manifest.json version {manifest['version']} != plugin {plugin['version']}")
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, path in entries():
            info = zipfile.ZipInfo(name, _EPOCH)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            z.writestr(info, path.read_bytes())
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    print(build(ap.parse_args().out))


if __name__ == "__main__":
    main()
