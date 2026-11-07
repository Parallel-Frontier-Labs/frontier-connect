# Frontier for your AI apps

**Enterprise AI agents, held to your standard on every run, from the AI app your team already uses.**

Hand [Frontier](https://parallelfrontier.io) the work, not the prompt. Ask in the AI app you
already use, and Frontier's agents run it end to end on your files with your firm's own
playbooks. The finished files come back into your folder.

Frontier works in any AI app that supports MCP connectors, such as Claude and ChatGPT (see
[every surface](../README.md#any-ai-app-surface-one-platform-beneath)). This plugin adds folder
upload and delivery to your computer in Claude, Codex and Microsoft Copilot.

> **Rolling out with Frontier customers.** To get access, [book a session](https://parallelfrontier.io/book).

## What you get

- **Your best people's methods, on every run.** Playbooks are your firm's reviewed methods for
  recurring work, such as a client review or a return prep. The assistant finds them by name, and
  Frontier runs them the same way for everyone.
- **Every run scored against your bar.** Each task is checked against your firm's own criteria
  the moment it finishes, and the full record of the run stays in Frontier.
- **A live task card in the chat.** The plan, each step, any question Frontier needs answered and
  the deliverables, without leaving the conversation.
- **All your tasks, full screen.** Expand the task list to search by title, read any task's prompt
  and results side by side, and delete what you no longer need.
- **Files back where you work.** Deliverables are saved next to your work in a folder named after
  the task, and your own edits are never overwritten.

## Ask for whole pieces of work

Ask the way you would brief a colleague: the inputs, what you need back, and your standard.

- **Tax prep:** "Use Frontier to prepare a draft 2025 return from the W-2s, 1099s and K-1s in this
  folder. Fill in the forms, and list every figure a CPA should check, with the document and page
  it came from."
- **Advisor recruiting:** "Use Frontier to find 20 advisors within 30 miles of Austin who could be
  a fit to join our firm: 10+ years in the business and a clean record. For each, tell me why they
  might be open to a move, and draft a short first note."
- **Portfolio review:** "Use Frontier to review the custodian statements in this folder for the
  Lee household. Flag every position over 10% of the portfolio, show the tax cost of trimming each
  one, and draft a one-page rebalancing memo I can send the client."
- **Research:** "Use Frontier to compare the five leading CRM platforms for a 40-person firm on
  pricing, integrations and time to set up, with sources, and recommend one in a two-page brief."
- **Contract review:** "Use Frontier to read the vendor contracts in this folder and build a sheet
  of renewal dates, notice periods and auto-renewal terms, flagging anything that renews in the
  next 90 days."

One chat is one Frontier task: follow-ups in the same chat continue it, and the same folder is
updated with the new results.

## What's inside

The plugin bundles the Frontier connector (the MCP server at `https://api.parallelfrontier.io/mcp`)
and one skill, `frontier`, that tells the assistant how to run a task from start to finish. The
skill's helper script (`skills/frontier/scripts/frontier.py`, Python 3 standard library only) moves
a folder up to a task and brings the delivered files back.

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
3. The helper moves files through `api.parallelfrontier.io` only, so that is the one host it
   needs to reach.

In Claude Code: `/plugin marketplace add Parallel-Frontier-Labs/frontier-connect`, then
`/plugin install frontier@parallel-frontier`.

**Microsoft Copilot (Cowork)**

Copilot installs plugins from a Microsoft 365 app package rather than a marketplace. Build it with
`python3 scripts/build_copilot.py` (it writes `dist/frontier-copilot.zip`: the manifest and icons in
`copilot/`, the connector's tool list and this same `frontier` skill), or download it from the
Connect AI apps page of your Frontier dashboard. Then:

1. In Copilot, open **Cowork > Customize > Plugins > Add plugin** and upload the zip.
2. Share it with **Only you** (an admin can add it for the whole organization from the Microsoft
   365 admin center).
3. Sign in with your Frontier account when Copilot first uses Frontier.

`copilot/tools/frontier-tools.json` is the connector's tool list (`tools/list` of the Frontier MCP
server, the tools the assistant may call). Regenerate it when the server's tools change.

## How a task runs

You ask; the assistant uploads the folder, starts the task and keeps the task card in view. When
the task is done it saves the deliverables into a subfolder named after the task and tells you
where. After a follow-up it updates that same folder.

## Your files and privacy

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
After a fetch that saved every file, the helper tells Frontier the name of the task's folder
(only its name, never where it is on your computer), so the task card can show the files as
saved.

## For plugin developers

The helper lives under the skill's `scripts/` folder rather than a top-level `bin/`, because a
top-level `bin/` stops claude.ai and Cowork from installing a plugin.

## License

Apache-2.0, see [LICENSE](LICENSE). Frontier and the Frontier logo are trademarks of Parallel
Frontier Labs; the license does not grant rights to use them.
