# Protocol contract

## Slack command transport

Every command occupies the complete raw message text:

```
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"request-0001","target":"my-computer","command":"help","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

The markers are ASCII words (no Slack angle-bracket escaping). Schema source: `src/protocol.ts`. It defines bounded parameters, applied defaults, examples, errors and permissions for generated help. Unknown keys, duplicate JSON keys, claimed actors, prototype keys, extra text, marker injection, unsupported version and wrong target are rejected. Transport identity comes only from Slack event metadata, not JSON.

Events persist before acknowledgement. Command IDs are scoped to an authenticated principal; repeated exact requests execute once, conflicting reuse does not execute. The internal operation ID is separate and used as the backend clientUserMessageId. A bot cannot consume an unrelated human's approval-template ID.

## Shared app-server

The connector checks the configured CLI version, then uses `app-server proxy` with an optional explicitly configured socket. A local-only, default-off autoStartDaemon option may first call fixed `app-server daemon start` once with a15-second timeout; it is incompatible with an explicit socket. It never issues daemon stop/update or changes Codex updater policy. Official start may provision packages/manage the updater according to existing Codex settings. There is no fallback `app-server` process. StdIO messages use the generated protocol's newline-delimited objects, not shell text. Initialize opts into experimental APIs; model, reasoning, sandbox, approval policy and permission profiles are not overridden.

Only these method families are reachable through typed command handlers: thread list/loaded/read/start/resume/items/turns; turn start/steer/interrupt; queue add/start. There is no caller-supplied RPC method. Discovered unsupported methods are negatively cached for the current connection; a fresh epoch may probe again. Session summaries omit rollout paths and raw tool content.

`thread/resume` receives a captured explicit thread ID and `excludeTurns:true`. It rejoins shared sessions where supported. `canAcceptDirectInput !== true` fails closed. `steer` uses `expectedTurnId`, interrupt uses exact turn ID. `send` uses queue/add plus queue/start rather than turn/start, so an active shared turn is not implicitly steered by a check/start race. A rejected start leaves the accepted queue entry in place and reports that fact; no duplicate enqueue or fallback turn/start occurs. This depends on the supported queue API, with real-runtime acceptance still pending.

Each proxy connection has a unique epoch. Handlers capture both child identity and epoch so delayed events from an old child cannot impersonate a new connection. Malformed/ambiguous responses become uncertainty, never success. Closing the connector only closes its proxy; shared daemon lifetime remains the owner's responsibility.

## Requests and authority

Pending command/file approvals and nonsecret user questions receive fresh connector request IDs. All replies bind connector ID, epoch, session, turn and the original JSON-RPC callback. Only one reply can transition pending→responding. Server resolution notifications complete it. Disconnect/restart invalidates old callbacks.

Remote approvals require fully displayed bounded scope. Secret/oversized/missing command or diff, unknown requests, stdin-specific approval, grantRoot expansion and secret input remain local-required. No session/global decisions or policy amendments are offered. Timeout declines command/file requests or interrupts the exact user-input turn; unknown unsupported requests are not answered by guessed schemas.

A configured human may answer directly in the bound output thread. A dot may reference the actual human message using `humanMessageTs`; the connector fetches and validates the same-thread unedited human message and exact decision envelope. A quoted statement, actor field, inaccessible DM, or missing permission is not proof. Local owner-token clients cannot submit approval/input decisions.

## Durable delivery

Work inbox and Slack outbox are independent. Backend execution completion and response enqueue commit together. A Slack failure never retries the backend action. Each session's outbox preserves order even across rate backoff or uncertain deliveries; unrelated sessions can progress. Transient known rate limits may retry; network/unknown outcomes require local operator recovery. Exactly-once Slack delivery is not claimed.

Discovery exposes all shared-visible metadata with manageability reasons. Session control defaults to configured project roots/subdirectories; a local-only allowAllSharedSessions opt-in can authorize other shared sessions without expanding readonly file roots. Only explicitly bound policy-authorized sessions produce automatic final-answer messages. Tool output/reasoning are excluded, known credential patterns withheld, long responses chunked and paced. Invalid/unbound/revoked mapping errors use the safe configured global destination rather than an old thread timestamp.

## Tests versus evidence

The automated suite uses fake transports and a pure Node executable fixture. The compiled CLI is tested across real authenticated loopback HTTP with an ambient-proxy trap. Windows/macOS parameter/template tests on Linux are not native execution evidence. See `RUNTIME-VERIFICATION.md` for actual CLI probes and unresolved runtime gates.
