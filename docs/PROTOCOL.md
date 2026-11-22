# Protocol contract

## Slack command transport

The canonical envelope occupies the complete raw message text:

```
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"request-0001","target":"my-computer","command":"help","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

The markers are ASCII words (no Slack angle-bracket escaping). Schema source: `src/protocol.ts`. It defines bounded parameters, applied defaults, examples, errors and permissions for generated help. Unknown keys, duplicate JSON keys, claimed actors, prototype keys, extra text, marker injection, unsupported version and wrong target are rejected. Transport identity comes only from Slack event metadata, not JSON.

Authenticated trusted bots may alternatively preserve that exact envelope in one strictly validated section/plain_text block when fallback text is identical or has only CRLF/LF replaced by one space. An explicit plain_text command block must agree even when fallback text is already canonical; extra blocks/fields or conflicting commands reject. Ordinary rich_text display blocks do not supply commands. This narrow transport adapter does not relax the envelope parser or grant authority over any native decision. See [transport boundaries](DESKTOP.md#slack-传输兼容边界) for the full schema and live-verification limitation.

Events persist before acknowledgement. Command IDs are scoped to an authenticated principal; repeated exact requests execute once, conflicting reuse does not execute. The internal operation ID is separate and used as the backend clientUserMessageId.

## Shared app-server

The connector checks the configured CLI version, then uses `app-server proxy` with an optional explicitly configured socket. A local-only, default-off autoStartDaemon option may first call fixed `app-server daemon start` once with a15-second timeout; it is incompatible with an explicit socket. It never issues daemon stop/update or changes Codex updater policy. Official start may provision packages/manage the updater according to existing Codex settings. There is no fallback `app-server` process. The official proxy is a raw byte tunnel: the connector performs an HTTP WebSocket upgrade over its stdio pipes and sends JSON RPC objects as bounded WebSocket text frames, not newline-delimited stdio or shell text. Initialize opts into experimental APIs; model, reasoning, sandbox, approval policy and permission profiles are not overridden.

Only these method families are reachable through typed command handlers: thread list/loaded/read/start/resume/items/turns; turn start/steer/interrupt; queue add/start/list. There is no caller-supplied RPC method. Discovered unsupported methods are negatively cached for the current connection; a fresh epoch may probe again. Session summaries omit rollout paths and raw tool content.

`thread/resume` receives a captured explicit thread ID and `excludeTurns:true`. It rejoins shared sessions where supported. `canAcceptDirectInput !== true` fails closed. `steer` uses `expectedTurnId`, interrupt uses exact turn ID. `send` uses queue/add plus queue/start rather than turn/start, so an active shared turn is not implicitly steered by a check/start race. A rejected start does not establish queue retention or non-delivery: queue/add can wake automatic dispatch before replying. Queue admission, start outcome and exact correlated turn lifecycle are persisted separately, with no duplicate enqueue or fallback turn/start. `session.delivery` performs bounded read-only evidence reconciliation, or cached inspection with refresh:false. See [SESSION-DELIVERY.md](SESSION-DELIVERY.md) for state semantics and experimental-protocol limits; live-runtime validation remains separate.

Each proxy connection has a unique epoch. Handlers capture both child identity and epoch so delayed events from an old child cannot impersonate a new connection. Malformed/ambiguous responses become uncertainty, never success. Closing the connector only closes its proxy; shared daemon lifetime remains the owner's responsibility.

## Native requests and authority

The original Codex UI is the only place to act on native approvals and user-input requests. Neither Slack envelopes (including an authenticated human's) nor Connector local API calls grant authority to answer. Slack receives at most a fixed same-origin interaction notice: no command, diff, prompt, question, options or response template.

Expiry is a backend safety deadline, not remote approval. Only when current evidence still identifies the exact request/epoch/session/turn originating from the original accepted Slack operation, with current scope and routing intact, may Connector decline that exact supported command/file callback or interrupt that exact input turn. A request that is stale, resumed in another epoch, user-resolved, unsupported, foreign, local, or unproven is not answered based on old data. Do not retry a decision or interrupt another turn to resolve uncertainty.

## Durable delivery

Work inbox and Slack outbox are independent. Connector handler completion and response enqueue commit together. This is not model-turn completion; message delivery has its own evidence fields. A Slack failure never retries the backend action. Each session's outbox preserves order even across rate backoff or uncertain deliveries; unrelated sessions can progress. Transient known rate limits may retry; network/unknown outcomes require local operator recovery. Exactly-once Slack delivery is not claimed.

Discovery exposes all shared-visible metadata with manageability reasons. Session control defaults to configured project roots/subdirectories; a local-only allowAllSharedSessions opt-in can authorize other shared sessions without expanding readonly file roots. Slack results omit native free-form content and use safe structured metadata and fixed notices only. Unknown or revoked routes are not given a fallback destination.

## Tests versus evidence

The automated suite uses fake transports and a pure Node executable fixture. The compiled CLI is tested across real authenticated loopback HTTP with an ambient-proxy trap. Windows/macOS parameter/template tests on Linux are not native execution evidence. See `RUNTIME-VERIFICATION.md` for actual CLI probes and unresolved runtime gates.

## Reply destination and explicit address

Every accepted Slack command response (including parser errors and ID conflicts) is durably routed to the event's own channel and `thread_ts`, or `ts` when the command itself is top-level. It never posts a channel-top fallback. New Slack session bindings use that origin thread. A command about an existing session returns to its caller. That does not authorize subsequent events in another thread: fixed async notices are routed only when there is evidence for the original accepted Slack turn and matching destination. An observer, local binding or newer command cannot acquire the original route.

The optional transport address is one leading `<@CONNECTOR_SELF_USER_ID>` followed by exactly one space, LF or CRLF. The identity comes from Slack auth.test, never command JSON or display names. For already-authenticated trusted bots only, `self-address-v2` additionally accepts `<@SELF_ID|label>` (1–80 label characters, no ASCII control characters or `< > & |`) or the single escaped token `&lt;@SELF_ID&gt;`. It canonicalizes only that complete leading self-address token, independently in fallback and plain_text block, before checking full equality or the existing exact newline-to-space transformation. Separators and all envelope bytes are preserved; no general HTML decoding, trimming, prose extraction or extra mentions. Different bodies, other IDs and extra blocks still reject. Canonical addresses remain available to authorized humans; the additional forms do not.

`capabilities.slackTransport` reports the transport revision and auth.test-resolved connector user/bot IDs (public Slack identifiers, not tokens). Rejections report only a fixed transport stage (`address`, `block-shape`, `fallback-mismatch` or `envelope`), never message content. Live Slack read projections have shown labelled/escaped addresses, but are not raw Socket Mode events; these compatibility tests do not establish the live root cause or prove the newly installed path until an authorized probe succeeds.

References: [Slack formatting and escaping](https://docs.slack.dev/messaging/formatting-message-text/) and [Slack legacy label parsing](https://github.com/slackhq/slack-api-docs/blob/master/page_formatting.md).


Local/Skill `session.create` and `session.attach` do not require a Slack destination. For an explicitly requested Slack binding, an operator can provide `outputThreadTs` for an existing, readable root in configured `outputChannel`. Scoped agents and MCP cannot choose Slack destinations. This is checked before creating a Codex session; Slack-origin commands cannot override their destination with this parameter. Explicit operator-authored text on an authorized binding remains a separate action and never replays or grants access to native output. Missing/unverified destinations fail closed; unbound local command output is not posted to Slack. On restart, persisted origins are retained. Old pending top-level or destinationless deliveries are marked failed, not silently rerouted. Channel revocation prevents delivery rather than choosing another channel.

## 文件与会话只读查询

文件命令保留 `{root:"项目别名",path:"相对路径"}`，新增省略 `root` 的原生绝对路径模式，例如 `files.list {"path":"/Volumes/Code/My/Skills","limit":20}`。仅本地 `filePolicy.allowAbsolutePaths:true` 生效，默认关闭；远程参数不能启用。完整边界见 [READONLY-FILES.md](READONLY-FILES.md)。

`session.list` 每次分别读取最多 `limit` 条 indexed interactive history 与 loaded ID，合并可达 `2*limit`。`nextCursor` 为复合不透明游标；跨页按 ID 去重。`loaded:true` 只说明本轮服务观察，stored-only `loaded:null` 不证明当前未加载。读取 loaded 元数据失败保留 ID / `METADATA_UNAVAILABLE` / unknown，不擅自 resume。`binding` 仅返回仍授权的既有映射。不同服务、CODEX_HOME 或 `--no-daemon` 的独立进程不保证可见。

桌面使用认证 loopback API `action:"sessions",params:{limit,cursor}`，仅返回元数据，不经过模型命令队列、不发送 Slack、不隐式绑定。

### 简洁响应与观察订阅

Slack 的有界摘要可用 `result.page` 查看短期原线程详情，`result.next` 只继续受支持的安全元数据查询。Slack 默认只查 loaded、每来源最多 10 条。见 [SLACK-OUTPUT](SLACK-OUTPUT.md)。即使仅开启 Slack，也无法证明原生轮次不含另一个客户端的输入，因此不会发送任何原生用户或模型正文；绑定、订阅、分页和缓存恢复都不能改变这一边界。旧正文快照、待发消息和不确定投递不作为重播渠道。已经发送到 Slack 的消息不在连接器自动撤回范围内。

`session.recent {"limit":5}`（1–20）是只读元数据查询，返回有界候选中的生命周期时间排名和独立后端更新参考。它不是 `session.list view=active`：已完成且 idle 的会话也可能最近活跃。不自动建立控制绑定或订阅，记录器不把接收/读取时间当活动时间。见 [SESSION-RECENT.md](SESSION-RECENT.md)。

需要正文时使用原 Codex UI，或已启用且获授权的本机 `session.history` / `events`。本机接口不是 Slack 缓存的替代出口，不要自动把本机结果转贴到 Slack。

## Server-scoped local clients

`target` still addresses the connector instance. Optional `params.serverId` selects a registered backend (ID or alias); it never accepts a socket path or Home. With multiple registered profiles, every target must have a distinct canonical Home and report it during the handshake before becoming usable. A profile with an explicit socket must declare its expected Home; the unqualified official proxy defaults to inherited `CODEX_HOME` or the OS account default. A missing or mismatched Home is offline, not a reason to retry on a different server. The unpinned, single-target legacy route remains supported. For Slack, use `server.list` to discover the configured and authorized subset. See [local API and stdio MCP](LOCAL-AGENTS.md) for authentication, exact command receipts and scoped event cursors.
