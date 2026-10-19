# Frontier plugin

Hand long, multi-step work on your files to [Frontier](https://parallelfrontier.io)'s agents
from Codex or Claude (Cowork, Claude Code), follow it in a live task card, and get the finished
files back into your folder.

The plugin bundles the Frontier connector (the MCP server at `https://api.parallelfrontier.io/mcp`)
and one skill, `frontier`, that tells the assistant how to run a task: one chat is one Frontier
task, follow-ups continue it, and results are saved next to your work without overwriting
your own edits. The skill's helper script (`skills/frontier/scripts/frontier.py`, Python 3 standard
library only) moves a folder up to a task and brings the delivered files back.

## Install

**Codex app**

```sh
codex plugin marketplace add Parallel-Frontier-Labs/frontier-connect
```

Then install **Frontier** from the plugin list and sign in to Frontier when asked. When the
helper runs, approve its network access.

**Cowork and Claude**

1. Go to **Customize > Plugins > Add > Add marketplace** and enter
   `https://github.com/Parallel-Frontier-Labs/frontier-connect`.
2. Install **Frontier**, then connect it from the plugin's **Connectors** tab and sign in.
3. In Cowork, allow `api.parallelfrontier.io` and Frontier's file-storage host in the
   workspace's network allowlist, so the helper can move files. If a host is missing, the helper
   names it in its error ("Could not reach <host>"); add that host.

In Claude Code: `/plugin marketplace add Parallel-Frontier-Labs/frontier-connect`, then
`/plugin install frontier@parallel-frontier`.

## Use it

Ask, for example, "Use Frontier to reconcile the spreadsheets in this folder and flag every
mismatch." The assistant uploads the folder, starts the task and keeps the task card in view.
When the task is done it saves the deliverables into a subfolder named after the task and tells
you where; after a follow-up it updates that same folder.

## Privacy

The helper holds no credentials. Each transfer uses a short-lived ticket link
from your signed-in Frontier connector, sent only to `api.parallelfrontier.io`, and the files
themselves move over presigned https links that expire within minutes. It reads only the folder
you choose and writes only into the destination folder. Downloads land in a private temporary
folder first. In the destination the helper never moves or deletes anything. It updates a file
in place only when the file still holds exactly what Frontier delivered there before (a small
hidden `.frontier-task` file records that), and it keeps any file you changed, saving the new
version alongside as `name (2)`. If a fetch is interrupted, run it again: a file whose save
was cut off is kept as it is, the complete version is saved alongside as `name (2)`, and the
assistant tells you which files were affected so you can delete the incomplete copies.

## Layout note

The helper lives under the skill's `scripts/` folder rather than a top-level `bin/`, because a
top-level `bin/` stops claude.ai and Cowork from installing a plugin.

## License

Apache-2.0, see [LICENSE](LICENSE). Frontier and the Frontier logo are trademarks of Parallel
Frontier Labs; the license does not grant rights to use them.
