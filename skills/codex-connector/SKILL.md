---
name: codex-connector
description: Use the local codex-connector CLI to bind an explicitly identified shared Codex session to its Slack thread, send progress to that thread, or request supported session/read-only operations. Use when the user asks to connect this conversation to Slack or communicate through its configured dot.
---

# Codex Connector v0.2

Use the installed local CLI, not Slack tokens, raw RPC, shell bridges, or session-file scraping. The owner must have configured and started the connector and default shared Codex daemon. This Skill does not install services, change permissions, or establish credentials.

## Explicit identity

Use the known connector `sessionId`, or the exact shared Codex `threadId` supplied by the user/hosting runtime. Never guess a current-session environment variable, choose the latest session, or inspect Codex rollout/session files. If no reliable ID is available, ask which explicit session to bind. `session.attach` rejoins the supported shared daemon; it does not seize an unrelated standalone TUI.

A connector handle maps to one configured output-channel thread. Do not override channel/mention targets. Obtain the configured project alias from the owner if unknown.

## CLI

Use `codex-connector` if installed on PATH; otherwise `node /ABSOLUTE/connector/dist/src/cli.js`. User text must be separate arguments or a UTF-8 JSON params file, never concatenated into shell syntax.

```text
codex-connector help --command session.attach
codex-connector command --name session.attach --params-file bind.json
codex-connector status
```

`bind.json` contains `{"threadId":"EXPLICIT_THREAD_ID","project":"PROJECT_ALIAS"}`. The command returns an internal work `id`, not immediate execution success. Read `status`, locate that exact work ID, and wait only while it is queued/executing. On completion, its `resultRef.sessionId` identifies the binding. Do not choose the most recently created session. Stop on failed/uncertain status and report the error; never retry uncertain side effects automatically.

To create a separate shared session, use `session.create` with `{"project":"PROJECT_ALIAS","title":"Purpose"}` and correlate the work/resultRef in the same way. This does not change the identity of the current conversation.

Send explicit progress/replies:

```text
codex-connector command --name session.reply --params-file progress.json
```

`progress.json`: `{"sessionId":"KNOWN_HANDLE","text":"Progress to publish"}`. Bound shared sessions already relay final assistant messages automatically; do not duplicate the final answer via `session.reply` unless the user explicitly wants that.

Other commands include `session.list/info/history/send/steer/queue/interrupt`, readonly `files.list/stat/read/search`, `help` and `capabilities`. Use generated help before unfamiliar commands. Local command results are delivered through the configured Slack output route; `status` returns local metadata. The old v0.1 mailbox/read/ack interface is not supported.

## Permissions and decisions

Never read/print the local API token or Slack tokens. The CLI reads the private owner token itself. Never change allowlists, expose localhost publicly, disable the sandbox, or tunnel a blocked filesystem/network operation through the daemon.

If direct loopback HTTP is blocked by this Codex runtime, report the exact constraint and ask for a reviewed authorized setup. The CLI intentionally does not send its bearer through ambient proxies. Do not promise universal sandbox compatibility.

**Do not submit approvals or input decisions on the user's behalf.** The local API rejects those decisions. The connector asks the configured dot/human in the bound Slack thread and requires direct human metadata or an independently verified human message reference. Secret questions and broader/unsupported scopes must be handled locally. Never fabricate `approvedBy`, quote imagined permission, resolve pending failures automatically, or change Codex approval policy.

## Uncertainty

Default shared-session takeover is version/capability dependent. Inspect `capabilities` and report unsupported or disconnected state; never claim an independent replacement session is the user's existing one. `recover` and startup/service configuration are operator actions, not routine Skill steps. Do not invoke them automatically.
