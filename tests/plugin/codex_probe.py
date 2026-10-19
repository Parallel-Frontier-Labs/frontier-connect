"""Ask the real Codex plugin loader what it discovers in this repo's marketplace.

Usage: python3 codex_probe.py <repo root>. Needs the `codex` CLI on PATH. Exits non-zero unless
the frontier plugin has the frontier skill AND the frontier MCP server."""
import json, os, subprocess, sys, tempfile

def main(root: str) -> int:
    market = os.path.abspath(os.path.join(root, ".agents/plugins/marketplace.json"))
    home = tempfile.mkdtemp(prefix="codex-home-")
    p = subprocess.Popen(["codex", "app-server"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, env={**os.environ, "CODEX_HOME": home})
    def call(i, method, params):
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}) + "\n")
        p.stdin.flush()
        while True:
            line = p.stdout.readline()
            if not line:
                raise SystemExit(f"codex app-server closed before answering {method}")
            msg = json.loads(line)
            if msg.get("id") == i:
                if "error" in msg:
                    raise SystemExit(f"{method}: {msg['error']}")
                return msg["result"]
    try:
        call(1, "initialize", {"clientInfo": {"name": "frontier-ci", "version": "1"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "initialized"}) + "\n"); p.stdin.flush()
        res = call(2, "plugin/read", {"pluginName": "frontier", "marketplacePath": market})
    finally:
        p.kill()
    plugin = res["plugin"]
    skills = [s["name"] for s in plugin.get("skills", [])]
    servers = plugin.get("mcpServers", [])
    names = [s if isinstance(s, str) else s.get("name") for s in servers]
    logo = (plugin["summary"].get("interface") or {}).get("logo")
    problems = []
    if "frontier:frontier" not in skills:
        problems.append(f"skill missing (got {skills})")
    if "frontier" not in names:
        problems.append(f"MCP server missing (got {names})")
    if not logo or not os.path.isfile(logo):
        problems.append(f"logo missing (got {logo})")
    print("codex loader:", "OK" if not problems else "; ".join(problems))
    return 1 if problems else 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
