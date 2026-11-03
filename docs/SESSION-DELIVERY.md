# Message delivery evidence

`session.send` and `session.queue` now report message evidence separately from connector command execution. `session.steer` retains its existing exact-turn command semantics; this ledger does not silently reinterpret steering or Slack delivery as message receipt.

## Meaning of the states

- `queued`: the command is waiting in the connector's local inbox. It has not yet been submitted by that work item.
- `accepted`: the daemon acknowledged queue admission (or an exact queue entry was observed). This does **not** mean the message is still waiting in the queue, nor that a model turn finished.
- `processing`: an explicit queue/start response bound the selected queue entry to a running turn, or a user-message item with the exact client correlation ID was observed in a turn. This is evidence that the submission entered that turn, not proof of successful model/tool work.
- `completed`, `failed`, `interrupted`: the exact correlated turn has that terminal status. A completed turn does not certify task correctness or that every requested side effect succeeded.
- `uncertain`: an acknowledgement is missing/malformed, an RPC outcome is unresolved, or conflicting correlation IDs were observed. The message may already have been received. Never resolve this by enqueueing again.
- `not-submitted`: a known pre-submission/unsupported-operation failure. A queue/add RPC rejection alone is conservatively uncertain because a mutating handler can fail after a side effect.
- `unknown`: older work has no delivery ledger, or no supported evidence is available. No optimistic migration of old records.

The structured `admission`, `start`, and `execution` fields retain independent evidence. For example, `admission=accepted`, `start=rejected`, `execution=completed` is legitimate. `commandStatus=completed` means the connector handler returned, not that Codex completed the user's task. The local API's immediate `status=accepted` is explicitly labeled `acceptance=connector-inbox-only`, `deliveryConfirmed=false`.

## Why a rejected start is not failed delivery

Queue/add persists the submission and wakes an already-loaded session before replying. An autonomous dispatcher or another client can consume the entry before the connector's explicit queue/start. Also, queue/start can start a turn before a later queue-record deletion fails. Therefore `startError=RPC_REJECTED` cannot prove either “still queued” or “not received.” Queue presence can overlap execution; queue disappearance can mean deletion instead of processing.

If exact execution evidence arrives before the queue/add acknowledgement, the connector skips its now-redundant explicit start. The connector never falls back to turn/start or steer, never re-enqueues after a rejected/uncertain start, and never automatically retries a mutating RPC. Use the same request ID for transport retries. A new request ID represents new work and can duplicate the user's input; identical text is not an idempotency key. `clientUserMessageId` is correlation, not a cross-client exactly-once guarantee.

## Exact evidence and races

The connector persists a submission record before queue/add and persists its returned queue ID before queue/start. It sends its internal work ID as `clientUserMessageId`.

- User items correlate via **`item.clientId`**, not `item.id` or a guessed `item.clientUserMessageId` property. The thread ID and turn ID must also match.
- A successful queue/start with an explicitly selected queue ID supplies the matching turn ID. It never targets a different queue entry as fallback.
- A user-message `item/completed` event is not task completion. Assistant text, `final_answer`, generic thread activity, and unrelated turns cannot complete a message record.
- A bounded in-memory cache (500 thread/turn pairs) retains terminal events arriving before turn correlation. Stronger evidence is not overwritten by late RPC acknowledgements or duplicate started events. Cache eviction/missed events leave uncertainty; explicit readback can help.
- Reconnect/restart preserves IDs and established evidence, marks an observation gap, and never replays in-flight work. Old-epoch notifications are ignored. `observationGap` is a historical warning, not a liveness signal; false does not guarantee complete event coverage.
- Different queue IDs/turn IDs for one client correlation, or contradictory terminal statuses for the same turn, produce a conflict warning and `deliveryStatus=uncertain`, rather than selecting whichever response arrived last.

Only metadata is added to the work record; no extra copy of user/model content is stored. Readback only returns correlation/status metadata. Existing original-command retention is unchanged.

## Querying the latest evidence

Use the exact connector session handle and original internal work ID:

```json
{"command":"session.delivery","params":{"sessionId":"session-demo","workId":"work-demo"}}
```

The command is read-only toward Codex. By default it performs two metadata/scope checks surrounding at most one queue/list page, one items/list page, and one turns/list page (20 entries each). Each RPC has a 5-second timeout and a 1-MiB response budget. It never resumes, starts, steers, or resends a session. Reads are separate and non-atomic. Epoch/scope changes discard collected evidence; revoked scope fails closed.

Readback matches an exact client correlation ID even if the queue/add acknowledgement and queue ID were lost. Multiple matches with conflicting queue IDs remain uncertain. The queue observation reports `present` or `not-observed` at its own observation time. Missing entries, older data outside the bounded pages, unsupported methods, unavailable persisted items and read failures do not prove non-delivery. Inspect `coverage`, its errors and `hasMore` fields. This query deliberately does not scan all history.

Set `refresh:false` for cached evidence only. Cached evidence and old result.page snapshots are not current live state. Querying session.delivery creates a new result snapshot; reading result.page never refreshes or reruns the send. Local `status` includes separate command and message status fields but is not a full result mailbox. Slack delivery queries require the original actor/channel/thread, plus current session authorization; the authorized local API may inspect exact work IDs.

An originally uncertain command remains uncertain in the operational inbox even if later evidence proves processing or completion. Its session mutation lane stays blocked until the existing local operator recovery flow is explicitly used. This separates resolution of the model result from permission to resume controls. Recovery never replays the original action.

No new unsolicited Slack status stream is added: initial responses and explicit delivery queries expose the ledger; existing authorized session notifications retain their existing destination.

## Protocol limits and validation

Queue APIs are experimental. Older runtimes may not support queue/list or may omit user `clientId`; such gaps remain explicit instead of being guessed. Another client can edit/delete a queued entry and preserve its client ID: the ledger tracks the correlated submission/turn, not an immutable audit of the original text. No exactly-once or universal version-compatibility claim is made.

The implementation was checked against upstream commit `3026a8e54e0f48c4d8074cd700f35b0697abc329`:

- [Queue request/response definitions](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L935-L1040)
- [Queue enqueue/start ordering](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/ext/queue/src/service.rs#L265-L402)
- [User-message clientId conversion](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L936-L943)
- [Queue-change notification has no delivery mapping](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/app-server-protocol/schema/typescript/v2/ThreadQueueChangedNotification.ts)

Regression tests use the fake backend only. They cover automatic consumption before acknowledgements, rejected/lost/malformed RPCs, exact and wrong correlation, terminal-event races, failures/interruption, duplicate requests, restart and stale epochs, bounded readback, scope changes and correlation conflicts. These tests do not replace a separately authorized live-runtime acceptance check.
