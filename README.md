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
| Claude (web, Desktop, Cowork) | Custom connector |
| ChatGPT and the Codex app | Custom app (developer mode) |
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
| `frontier_request_upload` | Returns upload links so the assistant can hand files to a task. |
| `frontier_start_task` | Starts a task and returns the live task card. |
| `frontier_wait_task` | Waits for the next update (a step, a question, files ready, done). |
| `frontier_get_task` | Returns the current state of a task. |
| `frontier_list_tasks` | Lists your recent tasks. |
| `frontier_stop_task` | Stops a running task. |

## Privacy and control

- **Your assistant sees summaries, not your data.** Hosts receive only the progress summaries and
  deliverable names Frontier chooses to share. Your files and the agents' working transcripts stay
  in Frontier.
- **Your account, your permissions.** Sign-in uses OAuth 2.1 with PKCE and scoped access. Revoke
  any connected app at any time from your Frontier admin dashboard, and it stops working at once.
- **Every run is recorded.** Connector runs appear in your Frontier admin dashboard alongside every
  other run, labelled with the app that started them.

## What's in this repo

This repository holds the open-source **task card**, the
[MCP App](https://modelcontextprotocol.io) that renders a Frontier task inside the chat. It is a
small Preact app built into a single self-contained HTML file with no external scripts.

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

Frontier and the Frontier logo are trademarks of Parallel Frontier Labs. The license does not grant
rights to use them.
