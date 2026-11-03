# Slack transport and command examples

Read this when assembling a command. These are examples, not real requests: replace instance/IDs, project aliases, timestamp and text with verified values, use a new request ID for every distinct command, and send **only one** envelope per Slack message. The document's code fences are not part of the payload. Runtime `help` is authoritative for the installed version.

## Transport

Preferred message text is a complete multiline envelope, optionally preceded by one verified connector mention and one newline. If a bot sender needs the explicit block fallback, this is the entire message payload shape (substitute the verified connector ID and instance in both copies):

```json
{
  "text": "<@UCONNECTOR>\nCODEX_CONNECTOR_COMMAND_BEGIN\n{\"v\":1,\"id\":\"dot-help-0002\",\"target\":\"my-computer\",\"command\":\"help\",\"params\":{}}\nCODEX_CONNECTOR_COMMAND_END",
  "blocks": [{
    "type": "section",
    "text": {
      "type": "plain_text",
      "text": "<@UCONNECTOR>\nCODEX_CONNECTOR_COMMAND_BEGIN\n{\"v\":1,\"id\":\"dot-help-0002\",\"target\":\"my-computer\",\"command\":\"help\",\"params\":{}}\nCODEX_CONNECTOR_COMMAND_END",
      "emoji": false
    }
  }]
}
```

The outer Slack-tool argument name for fallback text varies by sender (`message` versus `text`); preserve the values and consult that sender's schema. It must support passing the exact single plain_text block. Do not assume a tool succeeded at preserving newlines: a connector rejection means inspect the transport, not grant permissions or change the JSON grammar.

## Connection and filtered discovery

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-capabilities-0001","target":"my-computer","command":"capabilities","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-list-active-0001","target":"my-computer","command":"session.list","params":{"view":"active","limit":10}}
CODEX_CONNECTOR_COMMAND_END
```

## Recent execution evidence, then task identification

For “recently active 5 sessions”, use this metadata-only query. `limit` is 1–20, default 5. Ranked lifecycle evidence is distinct from `updatedCandidates` (generic backend-update references), and coverage is bounded, not global top N. Missing activity timestamps do not imply inactivity. Current running/idle/unknown state is a separate observation. The connector does not automatically attach sessions to collect a complete activity history.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-recent-0001","target":"my-computer","command":"session.recent","params":{"limit":5}}
CODEX_CONNECTOR_COMMAND_END
```

Use `result.page` if needed to inspect errors, activity source and coverage. This command has no `result.next` continuation. Select a few exact Codex thread IDs from the result for overview below, then read messages or subscribe only as requested. Do not use a backend update timestamp, receipt time, or connector control handle as proof of execution or as the Codex thread ID.

## Select a few candidates, then read one exact thread

After recent/list discovery, use 1–5 distinct **Codex thread IDs**, not connector session handles. Read the overview's per-thread errors, scan coverage and message phase/text status before inferring the task. These are excerpts from available persisted items, not semantic summaries or a current-task guarantee.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-overview-0001","target":"my-computer","command":"session.overview","params":{"threadIds":["thread-demo","thread-other"],"maxChars":500}}
CODEX_CONNECTOR_COMMAND_END
```

Read one selected thread without attaching. Default descending order shows the latest available items first; use ascending only when earlier context is needed. `limit` counts backend items before visible-role filtering, so a zero-message page can still continue.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-messages-0001","target":"my-computer","command":"session.messages","params":{"threadId":"thread-demo","role":"all","order":"desc","limit":10,"maxChars":1000}}
CODEX_CONNECTOR_COMMAND_END
```

Continue with the returned `result.next` handle, or a real opaque `cursor` with the same threadId/role/order. Use `result.page` to expand already-returned excerpts; it does not fetch additional historical messages or remove per-message truncation. If observation is requested, subscribe to the exact identified thread only after confirming it is currently loaded. Content reading and subscribing do not grant control or approval authority.

## Read result details versus fetch the next query page

These require a real result handle issued to this same actor/channel/thread. `page` is one-based. `result.next` is valid only when a session-list or session-messages result advertises a next query page. It preserves the saved query scope; it does not repeat a control operation.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-result-page-0001","target":"my-computer","command":"result.page","params":{"resultId":"result-demo","page":1}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-result-next-0001","target":"my-computer","command":"result.next","params":{"resultId":"result-demo"}}
CODEX_CONNECTOR_COMMAND_END
```

## Observe a loaded thread, inspect subscriptions, cancel observation

Use the exact shared Codex thread ID for subscribe; use the returned subscription ID for unsubscribe. Cancellation does not stop Codex. Keep the same authenticated sender and origin thread.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-subscribe-0001","target":"my-computer","command":"session.subscribe","params":{"threadId":"thread-demo"}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-subscriptions-0001","target":"my-computer","command":"session.subscriptions","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-unsubscribe-0001","target":"my-computer","command":"session.unsubscribe","params":{"subscriptionId":"subscription-demo"}}
CODEX_CONNECTOR_COMMAND_END
```

## Explicit control binding and bounded actions

Attach is separate from observation. Omit `outputThreadTs` in Slack. `project` can be omitted only if the selected thread is allowed by local session policy. Use the returned connector session handle, not thread/subscription IDs, for subsequent commands. Inspect `session.info` and direct-input capability before choosing a send/queue/steer/interrupt operation.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-attach-0001","target":"my-computer","command":"session.attach","params":{"threadId":"thread-demo","project":"demo"}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-info-0001","target":"my-computer","command":"session.info","params":{"sessionId":"session-demo"}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-queue-0001","target":"my-computer","command":"session.queue","params":{"sessionId":"session-demo","text":"When ready, summarize the test results.","resume":false}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-steer-0001","target":"my-computer","command":"session.steer","params":{"sessionId":"session-demo","turnId":"turn-demo","text":"Focus on the failing tests first."}}
CODEX_CONNECTOR_COMMAND_END
```

## Read-only file operation

Use a configured root, not an arbitrary path passed off as an alias. Absolute mode is a separate local opt-in; never add an enable flag to Slack params.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-files-0001","target":"my-computer","command":"files.list","params":{"root":"demo","path":".","limit":20}}
CODEX_CONNECTOR_COMMAND_END
```

## Human decision relay, never self-approval

Do **not** send the following until the configured human has actually posted the matching complete, unedited decision envelope in the bound thread. Copy correlation fields from the live request, copy their decision/answers exactly, and set `humanMessageTs` to that real human message. The human's direct template has the same decision params **without** the proof locator; their request ID may differ. The timestamp itself is not authority.

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-decision-relay-0001","target":"my-computer","command":"approval.respond","params":{"requestId":"request-demo","epoch":"epoch-demo","sessionId":"session-demo","turnId":"turn-demo","decision":"decline","humanMessageTs":"1700000000.000002"}}
CODEX_CONNECTOR_COMMAND_END
```

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"dot-input-relay-0001","target":"my-computer","command":"input.respond","params":{"requestId":"request-demo","epoch":"epoch-demo","sessionId":"session-demo","turnId":"turn-demo","answers":{"question1":["Option A"]},"humanMessageTs":"1700000000.000003"}}
CODEX_CONNECTOR_COMMAND_END
```

The question ID and option above are examples; use only the actual prompt's IDs and allowed options. `NEED_VERIFIABLE_HUMAN_DECISION` requires the human to use the original bound thread or local UI, not weaker proof. `STALE_OR_MISROUTED_REQUEST` requires a current exact request, not rewriting old IDs. No observation subscription, mention, user quote or help output confers approval authority.


## Message delivery evidence

`session.send` / `session.queue` return `workId`, `commandStatus`, `deliveryStatus`, and separate `admission`, `start`, `execution` evidence. Local immediate acceptance only means the connector inbox accepted work. Command `completed` is not model completion. A `startError` does not mean “still queued” or “not received”: queue/add can automatically dispatch before replying. Never resend with a new request ID to resolve uncertainty.

Use `session.delivery {"sessionId":"session-demo","workId":"work-demo"}` to refresh exact evidence. It makes bounded read-only queue/items/turns queries (20 entries per page), never starts or resubmits. `refresh:false` returns cached evidence. Inspect coverage/errors; missing evidence is unknown, not non-delivery. Slack queries require the original actor/channel/thread. User-message correlation is `item.clientId`; assistant final text and unrelated latest turns do not establish completion. Only the exact correlated terminal turn supports completed/failed/interrupted. An observation gap or older snapshot is not live state. Full semantics: docs/SESSION-DELIVERY.md.
