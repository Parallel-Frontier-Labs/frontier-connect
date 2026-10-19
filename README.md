# Frontier Connect

**Self-optimizing AI agents, from inside Claude and ChatGPT.**

[![CI](https://github.com/Parallel-Frontier-Labs/frontier-connect/actions/workflows/ci.yml/badge.svg)](https://github.com/Parallel-Frontier-Labs/frontier-connect/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![MCP 2026-07-28](https://img.shields.io/badge/MCP-2026--07--28-black.svg)](https://modelcontextprotocol.io)

[Frontier](https://parallelfrontier.io) agents do your organization's work to your standard.
Every run is scored against your own bar, and the runtime routes each step to the most efficient model
that clears it. Quality goes up, cost goes down, and everything the system learns stays with you.

Frontier Connect brings that runtime to the AI apps your people already use. Describe the work in
Claude or ChatGPT, and Frontier's agents run it end to end. A live task card in the conversation
shows the plan, progress, any questions and the finished deliverables.

> **Status: rolling out.** The connector is in staged rollout with Frontier customers.
> To get access, [book a demo](https://parallelfrontier.io/book).

## Any AI app surface, one platform beneath

Keep the tools your teams prefer. Every surface calls the same Frontier MCP server, so a task
started from Claude gets the same playbooks, the same quality checks and the same run record as
one started in Frontier's own app.

| Surface | How it connects |
|---|---|
| Cowork and Claude Code | The Frontier plugin (connector plus folder upload and delivery) |
| Claude (web, Desktop) | Custom connector |
| The Codex app | The Frontier plugin |
| ChatGPT | Custom app (developer mode) |
| Frontier's desktop app | Built in |
| Your own AI engine | Any MCP client |

## The loop behind every run

Every task started from Claude or ChatGPT feeds the same loop as work done anywhere else in
Frontier. That is what makes the agents self-optimizing.

1. **Observe.** Every run is traced step by step: prompts, tool calls, model choice, tokens,
   duration and cost. Each run is scored against your bar the moment it finishes.
2. **Optimize.** Frontier groups the ad-hoc tasks your people keep repeating, ranks the ones a
   playbook would improve most, names what goes wrong and proposes the fix.
3. **Evaluate.** Your rubrics decide what good means, criterion by criterion. Every run of every
   skill is scored against its own bar, and misses are grouped by cause.
4. **Experiment.** A team edit, a model swap or a new playbook version runs against the live one
   on the same cases, scored side by side on quality, cost, duration and tokens.
5. **Improve.** Proven changes come back as playbook updates your admins approve once. Every
   surface, this connector included, picks up the better version on its next run.

The runtime matches each step to the most efficient mix of open and closed models that clears your
bar, so quality goes up while cost comes down.

## What you can hand off

Delegate whole pieces of work, not single prompts. For example:

- "Use Frontier to reconcile these twelve spreadsheets and flag every mismatch."
- "Use Frontier to build briefing packets for my three customer meetings tomorrow."
- "Use Frontier to research the five leading vendors in this space, with sources."
- "Use Frontier to review these contracts against our standard terms and summarize the gaps."
- "Use Frontier to run our quarterly report playbook on this quarter's data."

If your organization has playbooks (proven, reviewed methods for recurring work), the assistant
can find and use them by name.

## Tools

| Tool | What it does |
|---|---|
| `frontier_list_playbooks` | Lists your organization's playbooks and the skills inside them. |
| `frontier_request_upload` | Returns upload links (or, with the plugin, one ticket for a whole folder) so the assistant can hand files to a task. |
| `frontier_request_download` | Returns a short-lived ticket the plugin uses to save a task's delivered files into a local folder. |
| `frontier_start_task` | Starts a new task and returns the live task card. Only for separate, new work. |
| `frontier_continue_task` | Continues the chat's existing task with a follow-up (same files, history and record). The default for any follow-up. Takes no skills: follow-ups keep the skills chosen at the start. |
| `frontier_wait_task` | Waits for the next update (a step, a question, files ready, done). |
| `frontier_get_task` | Returns the current state of a task. |
| `frontier_list_tasks` | Lists your own recent tasks in the card: filter by dates, status and app, open one, load more. |
| `frontier_stop_task` | Stops a running task. |
| `frontier_answer` | Sends the user's answer to a task's question or form. The task card uses it too. |
| `frontier_steer` | Gives a running task new guidance from the user. |
| `frontier_delete_task` | Used only by the card, when you click Delete and confirm. Hidden from the assistant. |

Deleting a task is something only you do, in the card: open the task list, choose Delete on a
task and confirm. The assistant cannot delete tasks.

One chat, one Frontier task: follow-ups in a chat continue the task already started there
(`frontier_continue_task`), a running task takes new direction through `frontier_steer`, and a new
task starts only when the user asks for separate work. See [AGENTS.md](AGENTS.md#how-to-run-a-task).

## Privacy and control

- **Your assistant sees summaries, not your data.** Hosts receive only the progress summaries and
  deliverable names Frontier chooses to share. Your files and the agents' working transcripts stay
  in Frontier.
- **Your account, your permissions.** Sign-in uses OAuth 2.1 with PKCE and scoped access. Revoke
  any connected app at any time from your Frontier admin dashboard, and it stops working at once.
- **Every run is recorded.** Connector runs appear in your Frontier admin dashboard alongside every
  other run, labelled with the app that started them.

## The Frontier plugin (Codex and Cowork)

The [`plugin/`](plugin) folder is a plugin for the Codex app and for Cowork and Claude Code. It
bundles the connector with a `frontier` skill and a small Python helper that uploads a whole local
folder to a task and saves the delivered files back into your folder, never overwriting your own edits.
The helper holds no credentials: it uses short-lived links handed out by your signed-in connector.

- Codex: `codex plugin marketplace add Parallel-Frontier-Labs/frontier-connect`, then install
  **Frontier**.
- Cowork and Claude: **Customize > Plugins > Add > Add marketplace** with this repository's URL,
  then install **Frontier** and connect it.

See [plugin/README.md](plugin/README.md) for details.

## What's in this repo

This repository holds the open-source **task card**, the
[MCP App](https://modelcontextprotocol.io) that renders a Frontier task inside the chat. It is a
small Preact app built into a single self-contained HTML file with no external scripts or fonts.
It follows the chat app's light or dark theme, and lets the user answer a task's questions and
forms in place.

It also holds the Frontier plugin in [`plugin/`](plugin), with the helper's tests in
`tests/plugin` (`python3 -m unittest discover -s tests/plugin`).

The Frontier MCP server and agents are hosted by Parallel Frontier Labs; they are not in this
repository.

```sh
npm ci
npm test
npm run build   # writes dist/task-card.html
```

## For AI agents

See [AGENTS.md](AGENTS.md) for when to delegate to Frontier and how to follow a task.

## Security

See [SECURITY.md](SECURITY.md).

## License

Apache-2.0, see [LICENSE](LICENSE).

The built card embeds the Public Sans and IBM Plex Mono fonts under the SIL Open Font License 1.1;
see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Frontier and the Frontier logo are trademarks of Parallel Frontier Labs. The license does not grant
rights to use them.
