---
name: codex-connector
description: Use the local Codex Connector CLI to bind an explicitly identified shared Codex session to an existing Slack thread, publish progress, or request supported session and read-only file operations. Use for local Codex-to-Slack work, not for sending connector commands as dot in Slack.
---

# Local Codex Connector

Use the installed local CLI against the owner's already configured connector. This skill does not install software/services, start a replacement Codex server, establish credentials, or authorize additional session actions. For dot's Slack transport, use the separate `dot-slack-connector` skill.

## Identify the exact session and destination

Distinguish the shared Codex `threadId`, connector binding `sessionId`, Slack root timestamp `outputThreadTs`, and active `turnId`. They are not interchangeable.

Use a reliable ID supplied by the user, hosting runtime, or supported discovery. Never guess a current-session environment variable, choose the latest session, infer identity from a matching title, or read Codex rollout/session files. If the request refers to “this conversation” but its exact thread ID is unavailable, ask for it rather than binding another session.

A new local binding requires an **existing, readable Slack thread root in the configured output channel**. Ask for its exact timestamp if unknown. A channel ID or message permalink is not a timestamp. The connector verifies the destination before creating a new session. `outputThreadTs` does not move an existing binding. No connector command creates a channel-top post.

## Use the actual CLI

Use `codex-connector` if installed on PATH, otherwise `node /ABSOLUTE/connector/dist/src/cli.js`. Use `--home /ABSOLUTE/PRIVATE_CONFIG` consistently if the owner configured a non-default home. `help` works without launching Codex. The CLI reads its private local API credential itself; never read, print or copy it.

```sh
codex-connector help --command session.attach
codex-connector status
codex-connector command --name session.attach --params-file bind.json --id bind-request-0001
```

`bind.json` is UTF-8 JSON:

```json
{"threadId":"thread-demo","project":"demo","outputThreadTs":"1700000000.000001"}
```

All example IDs, aliases, timestamps and paths are illustrative. Replace them with verified values. Put user text in a JSON params file, not shell concatenation. `--params-file -` reads JSON from stdin. For a genuinely different action, use a new command ID; a retry of the same action must retain its ID and exact content.

`command` returns acceptance with an internal work `id`, **not execution or Slack delivery success**. Read `status` and correlate that exact work ID. While queued/executing, continue checking for completion without resubmitting. A completed create/attach exposes `resultRef.sessionId` and `threadId`; do not select the newest binding. `resultRef` is metadata, not the full result body. Correlate outbox state separately before claiming a message was delivered. Failed or uncertain operations require inspection, not automatic replay or `recover`.

Local queries with no binding/Slack origin do not gain an output destination, and `status` is not a generic full-result mailbox. Do not invent `mailbox`, `read`, `ack`, `sessions` or other CLI subcommands. If the user needs discovery details unavailable through their current CLI flow, use an authorized desktop/Slack discovery route or ask for the explicit ID.

## Bind, create, publish and control

Read generated `help --command NAME` before unfamiliar parameters. Examples of command plus params-file content:

- `session.attach`: the binding JSON above. Omit `project` only for an explicit discovered thread allowed by the owner's local session policy.
- `session.create`: `{"project":"demo","title":"Review project","outputThreadTs":"1700000000.000001"}`. This creates a **separate** shared session, not the current conversation.
- `session.reply`: `{"sessionId":"session-demo","text":"Repository inspection is complete."}`. Publishes to the fixed binding without invoking the model. Bound sessions already relay final assistant messages; avoid duplicate final replies.
- `session.info`: `{"sessionId":"session-demo"}`. Inspect current metadata and recent turn IDs before control.
- `session.send`: `{"sessionId":"session-demo","text":"Explain the repository without editing files."}` for supported idle input.
- `session.queue`: `{"sessionId":"session-demo","text":"Next, summarize the findings.","resume":false}`. Queues without automatically starting it.
- `session.steer`: `{"sessionId":"session-demo","turnId":"turn-demo","text":"Focus on tests first."}`. Only the exact active turn.
- `session.interrupt`: `{"sessionId":"session-demo","turnId":"turn-demo"}`. Only when stopping that turn is authorized.

Attach success is not proof of direct-input support. Check `canAcceptDirectInput`, current capability errors and connection state. Never silently replace an unavailable shared session with an independent one. A send/queue can succeed in enqueueing but fail to start; do not enqueue the same message again after `startError` or an uncertain RPC outcome.

`session.list` accepts `view:loaded|active|history|all`, optional `project`, `limit` and returned opaque `cursor`. Local/desktop defaults are `all`, 50 per source; Slack defaults are `loaded`, at most 10 per source. `active` uses fresh metadata for a loaded page, not historical active labels. Page counts are not global counts; empty filtered pages can still have a continuation. Never infer idle from unknown metadata. Do not decode, invent or reuse cursors across filters.

Observation subscriptions and compact `result.page`/`result.next` handles belong to the authenticated Slack actor and originating channel/thread. They are not a local API shortcut or transferable bearer credentials. Do not send local subscription commands to impersonate dot.

## Read-only files and approval boundaries

`files.list/stat/read/search` use a configured `root` alias plus relative `path`. An absolute `path` without `root` requires the owner's **local** `filePolicy.allowAbsolutePaths` opt-in, disabled by default. Both modes remain read-only, subject to OS permissions, symlink/device/secret exclusions and bounded output. Do not change settings, enlarge roots, or route a blocked local operation through the connector to evade restrictions. All-shared-session control does not enable absolute file access.

The local API rejects `approval.respond` and `input.respond`. Relay the need for a decision through the bound Slack workflow; do not fabricate permission, approve your own actions, change approval policy, or forward secrets. Unknown, sensitive, broad or incomplete requests require the original local UI. Only current, exact requests can be answered; stale requests cannot be revived.

`status`/capabilities distinguish connectivity and method support. `doctor` only checks local configuration, token availability and executable existence. If loopback access is blocked, report the exact constraint; the CLI intentionally avoids ambient HTTP proxies for its bearer token. Do not expose localhost publicly, disable a sandbox, scrape protected files, install services or invoke `recover` as an automatic fallback.
