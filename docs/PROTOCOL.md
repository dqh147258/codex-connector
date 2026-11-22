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

The original Codex UI is the only place to act on native approvals and user-input requests. Neither Slack envelopes (including an authenticated human's) nor Connector local API calls grant authority to answer. By default Slack receives at most a fixed same-origin interaction notice. An explicitly granted future-content subscription may relay an active ordinary user-input title, question and option labels. No commands, diffs, security approval details, prompts or response templates are shared.

Expiry applies to the Connector reminder, not to the App Server request or turn. It records expiration locally, optionally relaying a fixed note to the same verified Slack origin, and never reads back native state to authorize or issue a decline, answer, or interrupt. Only the original Codex UI handles native approval and input.

## Durable delivery

Work inbox and Slack outbox are independent. Connector handler completion and response enqueue commit together. This is not model-turn completion; message delivery has its own evidence fields. A Slack failure never retries the backend action. Each session's outbox preserves order even across rate backoff or uncertain deliveries; unrelated sessions can progress. Transient known rate limits may retry; network/unknown outcomes require local operator recovery. Exactly-once Slack delivery is not claimed.

Discovery returns verified user/root sessions visible to the selected backend and scope, with manageability reasons. Child agents and unverified lineage are kept out of normal results and control. Session control defaults to configured project roots/subdirectories; a local-only allowAllSharedSessions opt-in can authorize other shared sessions without expanding readonly file roots. Ordinary Slack RPC results, search, views and pagination remain safe metadata only. A separate local operator grant permits prospective reply/question delivery, not historical or arbitrary results. Unknown or revoked routes are not given a fallback destination.

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

`session.list` 分别读取 indexed interactive history 与 loaded ID，每个来源最多检查四个上游页，并最多输出 `limit` 个已核实主会话；合并至多 `2*limit`。`nextCursor` 保存各来源的原生游标；过滤后空页仍可能有下一页。`loaded:true` 只说明本轮服务观察，stored-only `loaded:null` 不证明当前未加载。子 Agent、血缘未核实和读取失败只计入诊断，不伪造普通行、不自动恢复。不同服务、CODEX_HOME 或 `--no-daemon` 的独立进程不保证可见。

子 Agent 由官方 `source.subAgent`、`parentThreadId` 或 `threadSource: "subagent"` 识别；手工 fork 的 `forkedFromId` 不等于父子关系。保留官方 `cli`、`vscode`、`custom.atlas` 和 `custom.chatgpt` 主会话，`appServer` 需要确认来自自己的原生会话根；不可根据标题、路径或活动状态推断。订阅、绑定及重连重新查证，未核实旧记录不自动恢复或投递。参见[固定版本 wire 协议](https://github.com/openai/codex/blob/581161ab41e643d942e1e1b5f561034060bf18e3/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)。

桌面使用认证 loopback API `action:"sessions",params:{limit,cursor}`，仅返回元数据，不经过模型命令队列、不发送 Slack、不隐式绑定。

### 简洁响应与观察订阅

Slack 的有界摘要可用 `result.page` 查看短期原线程详情，`result.next` 只继续受支持的安全元数据查询。Slack 默认只查 loaded、每来源最多 10 条。见 [SLACK-OUTPUT](SLACK-OUTPUT.md)。默认只发固定状态。现有原生会话只能订阅固定状态。只有本机操作者在双入口模式下明确确认已核实的创建目标 Home／项目和 Slack 工作区／频道／根线程，随后核实创建成功的新专用会话，才允许该新会话的合规回复和问题送到原 Slack 线程。因为其他客户端可能影响共享回复，该提示必须随确认展示。绑定、普通订阅、分页或旧缓存不能开启、继续或搬迁分享。失去新会话身份或历史连续性即暂停而不是猜测。不确定的正文投递不会重投；已发送的消息不在自动撤回范围内。

`session.recent {"limit":5}`（1–20）是只读元数据查询，返回有界候选中的生命周期时间排名和独立后端更新参考。它不是 `session.list view=active`：已完成且 idle 的会话也可能最近活跃。不自动建立控制绑定或订阅，记录器不把接收/读取时间当活动时间。见 [SESSION-RECENT.md](SESSION-RECENT.md)。

需要正文时使用原 Codex UI，或已启用且获授权的本机 `session.history` / `events`。本机接口不是 Slack 缓存的替代出口，不要自动把本机结果转贴到 Slack。

## Server-scoped local clients

`target` still addresses the connector instance. Optional `params.serverId` selects a registered backend (ID or alias); it never accepts a socket path or Home. With multiple registered profiles, every target must have a distinct canonical Home and report it during the handshake before becoming usable. A profile with an explicit socket must declare its expected Home; the unqualified official proxy defaults to inherited `CODEX_HOME` or the OS account default. A missing or mismatched Home is offline, not a reason to retry on a different server. The unpinned, single-target legacy route remains supported for existing operations; native-content sharing still requires affirmative Home verification. Configured profile count is not capped; at most four native connection attempts start in parallel, each with independent timeouts. For Slack, use `server.list` to discover the configured and authorized subset. See [local API and stdio MCP](LOCAL-AGENTS.md) for authentication, exact command receipts and scoped event cursors.

The loopback operator-only action `native.share` accepts `inspect`, `preview-create`, `create`, and `revoke` with the canonical (not alias) server ID. It is not a Slack envelope or MCP action. For creation, the exact existing subscription supplies only the verified route, actor and project; it never supplies shareable content. Already-existing native sessions remain status-only; legacy `preview` and `grant` reject instead of implicitly creating one. The interactive CLI previews the separate blank session, exact destination and project, and warns that other clients' inputs can influence replies and that work in the new session during setup can later be sent. A short-lived, single-use typed owner confirmation is persisted before the official, non-ephemeral `thread/start` request. An independent native root, with a new UUIDv7, matching session ID, no fork or parent, no positive attachment evidence (the stable wire schema omits this experimental field), and no turns in the positive response, must be proved in the same verified Home/connection epoch. The connector does not infer birth, ownership or prior consent from displayed timestamps, notifications or persisted history; the latter can omit live work. Unknown acknowledgements never authorize sharing or an automatic duplicate create. The result provides separate `newNativeThreadId` and `newSubscriptionId`; `inspect` on the source shows the latest attempt. Only an already-proved new identity may resume after a restart.

A pending grant cannot queue or post. Once a positive create receipt is persisted, bounded in-memory sanitized projections can hold ordinary structured requests observed in that exact new session during setup, but dispatch still requires matching identity, live unresolved same-epoch evidence, and applicable tool/approval exclusions. Outbox rows bind the grant generation, service fingerprint, native turn/item, Slack workspace/route and part; actual dispatch requires current permission, the exact verified root and the same safe projection. Destination or identity changes retire old grants; older sharing policies cannot resume. The connector never answers native questions or takes approval actions. Recognized official approval IDs and native non-question evidence are denied independent of notification order. Tool evidence is bounded, scoped to the verified backend/thread and durable across reconnects; saturation closes structured questions only. See [SLACK-OUTPUT](SLACK-OUTPUT.md).
