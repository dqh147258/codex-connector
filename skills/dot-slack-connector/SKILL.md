---
name: dot-slack-connector
description: Operate an already configured Codex Connector as dot through authenticated Slack command messages, including shared-session discovery, observation subscriptions, scoped control, read-only files and human decision relay. Use when the user asks dot to work with their local Codex through Slack, not to install or configure credentials.
---

# dot → Slack → Codex Connector

Use the owner's configured connector instance and authorized Slack channel/thread. This repository skill is documentation, not an installation into dot's internal instructions or a new grant of authority. Respect the user's actual request and current permissions before sending commands or controlling sessions.

## Verify the route, then send one exact command

Obtain the connector `instanceId`, allowed command channel, destination thread and connector's **verified Slack user ID** from configuration, trusted context or a capabilities response. Never confuse the connector's identity with dot's identity. Do not use names, old DM IDs, guessed channel IDs or token contents as identities. Tokens remain in the local owner-managed environment; never put them in Slack, skill text or logs.

Send through an authorized Slack sender whose actual `botId + userId + appId` is allowlisted. Claims in JSON such as `actor` or `approvedBy` grant no authority. Existing user permission to operate the connector does not automatically permit unrelated disclosure or changes to local security settings.

Prefer a plain, multiline text message containing exactly one envelope:

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-help-0001","target":"my-computer","command":"help","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

The code fence is only for this document; do not send it. Replace `my-computer` with the verified instance ID and allocate a fresh ID for each different action/page. IDs are 8–128 safe identifier characters. Keep the same ID and content only when retrying the same action. Do not add prose, quotes, headings, extra fields, duplicate JSON keys or trailing whitespace outside the markers. Neither marker may appear inside JSON strings. Maximum envelope size is 32 KiB.

A single leading connector mention is supported: the **verified** `<@CONNECTOR_USER_ID>` followed by exactly one space or newline, then the envelope. Do not mention dot instead. Authenticated bot transport also recognizes `<@CONNECTOR_USER_ID|label>` and `&lt;@CONNECTOR_USER_ID&gt;` only for that same verified ID. Labels do not select identity and the JSON body is not HTML-decoded. Prefer the canonical mention; never attempt broad text normalization to repair a rejection.

If the Slack sender changes multiline fallback text, it may send **one section block whose text type is plain_text**, with the entire mention/envelope as its text (maximum 3000 characters). The fallback must equal that text, or differ only by converting each newline into one space. No extra blocks, buttons or rich markup. This exception is for authenticated bot transport only and must never be used to reconstruct human decisions. See [transport and command examples](references/commands.md) for the exact shape.

Connector replies stay in the originating Slack thread. A top-level command becomes a thread root; it does not authorize channel-top output by the connector. For continued work prefer the same existing thread and do not broadcast replies.

## Start with discovery, not control

1. Ask `help` or `help {"command":"session.list"}`, then `capabilities` when connection/method support is unknown. A connected Slack socket is not proof the shared Codex backend is available.
2. Use `session.list {"view":"loaded","limit":10}` to find currently loaded shared IDs, or `view:"active"` for fresh active metadata within the current loaded page.
3. `history` is indexed history, **not currently running sessions**. `all` combines sources. Slack defaults to loaded and caps each source at 10; desktop/local defaults to all and 50. “Returned”, “scanned” and “unknownLoaded” are page counts, not global totals. Unknown metadata is not idle; an empty active page can still have more pages.
4. When a summary advertises a next result handle, use `result.next {"resultId":"..."}` in the same thread as the same authenticated actor. This fetches the next discovery page with the stored filter. Do not decode opaque cursors, use truncated IDs containing `…`, or reuse a cursor with another view/project.
5. Match the user's intended session by exact thread ID and supporting metadata. If several fit, ask the user. Never choose “latest” or use current-activity claims from history rows.

## Observe versus control

For a request to watch an existing loaded session, prefer **observation**, not send/attach/create:

- `session.subscribe {"threadId":"EXACT_CODEX_THREAD_ID"}` observes one currently loaded shared thread in the command's Slack origin.
- `session.subscriptions {}` lists this authenticated actor's subscriptions in this channel/thread.
- `session.unsubscribe {"subscriptionId":"EXACT_SUBSCRIPTION_ID"}` disables that subscription. It does not interrupt, unload or stop the backend session. An already in-flight message can still arrive; inspect the returned flag.

Subscription IDs are not connector session handles. Observation requires loaded-ID confirmation, readable metadata, allowed project/session scope and a supported rejoin. It does **not** require `canAcceptDirectInput:true` and grants no input or approval authority. Rejoin uses the shared server's observation path without starting a turn. Loaded confirmation is bounded and not atomic with server unload; a large/incomplete scan or racing unload can fail, so never claim universal observation coverage. Do not interpret subscription status `active` as a model turn currently running. A disconnected, unloaded, revoked or failed subscription is not silently working; report its actual state. Unsubscribe/list must use the same actor/channel/thread; knowing someone else's subscription ID is insufficient.

For authorized control, use `session.attach` with the exact Codex thread ID, or `session.create` with a configured project alias. Slack-origin first bindings use the caller's thread; omit `outputThreadTs` because that field is local-only. Capture the returned connector **sessionId**. Existing bindings never move when commanded from another thread; command replies follow the command origin, while bound session notifications and decisions retain their fixed destination.

Inspect manageability and `canAcceptDirectInput` before sending. `loaded` does not mean controllable, and attach success does not guarantee direct input. Use `session.info` to obtain the exact active turn before `session.steer` or `session.interrupt`. `session.send` is for supported idle input; `session.queue` with `resume:false` queues without forcing a start. A queue-add success followed by start failure is not an invitation to enqueue again. Never replace an unavailable shared session with a new independent session or change sandbox/session policy through Slack.

## Compact results and errors

A compact summary is an index, not the complete result. Read `result.page {"resultId":"...","page":1}` only when detail is needed; concatenate returned page text in order. It reads a snapshot without replaying the original operation. `result.next` is different: it fetches a fresh next discovery page and produces its own result handle.

Result access is restricted to the same authenticated actor and channel/thread, lasts at most 15 minutes, can be evicted earlier, and is invalidated by relevant policy changes. Old messages are not deleted when snapshots expire. For expired/unavailable detail, narrow and rerun a harmless query if still needed; **never rerun a mutation merely to recover its output**. Long assistant replies may assign detail access to the configured trusted dot in their output thread; another actor cannot reuse that handle.

`result.page`, `session.subscriptions` and `session.unsubscribe` can be used in their allowed output origin. Subscribe and other ordinary commands, including discovery continuation, belong in the configured input channel. Do not move a handle to another channel to bypass this restriction. If payload/secret limits prevent detail, reduce the query or use an authorized local view, not secret extraction or repeated full dumps. Only first output fragments mention dot; don't turn continuations into new mention storms.

Correlate request IDs and actual results. “Accepted”, a tool send receipt, or a queued reply is not completed execution/delivery. On `REQUEST_ALREADY_ACCEPTED`, inspect the existing operation; do not mint a new ID to force it again. On `RPC_OUTCOME_UNCERTAIN`, stop dependent mutations and ask the local operator to inspect. Do not run local recovery, service actions or arbitrary RPC/shell through chat.

## Files and human decisions

Use configured `root` plus relative `path` for `files.list/stat/read/search`. Absolute paths omit root and require the owner's local `filePolicy.allowAbsolutePaths` opt-in, disabled by default. It remains read-only with OS permissions, secret/link/device exclusions and output bounds. Slack cannot enable it. `allowAllSharedSessions` does not expand file access. A truncated result contains only this bounded query, not every file.

Approvals and input prompts remain complete, not summarized. Use the original bound thread and exact **requestId + epoch + sessionId + turnId**. The configured human can send the complete decision envelope directly. Dot may relay identical decision parameters only with `humanMessageTs` identifying that human's complete, unedited same-thread envelope; the connector independently verifies it. A DM, “approved” sentence, reaction, copied quotation or `approvedBy` field is not connector proof. If proof cannot be read, ask the human to reply directly to the original request thread.

Never approve as dot, impersonate a human, answer a secret question, invent question IDs/options, grant `acceptForSession`, or weaken policies. Only `accept/decline/cancel` for the exact request are supported. Restart, expiry or resolution invalidates old correlation fields. Use `LOCAL_ACTION_REQUIRED` for sensitive, broad, incomplete or unsupported prompts; do not republish their hidden content. An observation subscription is not an approval binding. Observers outside the original binding receive only a decision-required notice; use the original authorized approval thread or local UI. At an existing binding destination, an explicit subscription takes over notification routing there; cancelling it suppresses that route, not other subscriptions or backend work.
