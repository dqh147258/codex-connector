# 最近活跃的 N 个会话

`session.recent {"limit":5}` 用于“当前没有 active 会话，但想知道最近在做什么”。limit 默认 5、范围 1–20。现在空闲不等于过去没有活动。

返回的 `sessions` 只按有真实生命周期时间证据的候选排序：`lastActivityAtMs` 降序，同毫秒按精确 `threadId` 升序。每行有标题、cwd、当前读取的状态、时间、`activitySource` 和 `activityEvent`。时间是生产者事件时间，不是 dot 查询时间。选择精确 threadId 后可调用 `session.overview`、`session.messages`，或在需要持续观察时明确 `session.subscribe`。控制操作仍使用独立的 connector sessionId。

## 时间依据

- `observed-lifecycle`：Connector 实际收到的 turn/started、turn/completed、item/started 或 item/completed 时间。turn 时间由服务端 Unix 秒转换为毫秒；item 使用服务端毫秒。`observedAtMs` 另外表示第一次收到所选事件的时间，不参与活跃排序。
- `latest-turn-lifecycle`：只读 `thread/turns/list {limit:1,sortDirection:"desc",itemsView:"notLoaded"}` 返回最近一轮明确的 startedAt/completedAt。取可用较大值；不会加载用户、模型、工具或 reasoning 消息。长时间执行中的一轮可能在开始后有更多活动，此字段不保证捕获全部进展。
- `updatedCandidates`：没有已知执行时间的候选，单独作为“后端最近更新”参考列表，保留后端原有排序。`backendUpdatedAtMs` 来自 thread.updatedAt，不是精确执行时间。绝不将它与真实生命周期时间混排或称作最近执行。
- 没有时间、字段不兼容、无法读取元数据或达到限制时，返回 unknown/错误和覆盖信息，不补成当前时间，也不声称会话不活跃。若后端不支持 notLoaded 元数据读取，不改用含消息正文的 summary/full 或文件扫描。

## 范围与限制

最多交错选取 40 个候选：本地已记录活动、共享 daemon 当前 loaded 的一页、按 updated_at 降序的 indexed interactive/nonarchived history 一页（所有 provider）。这是有界候选集合内的排名，`coverage.globalTopN` 始终为 false，不保证全机器、所有历史或所有独立 Codex 实例的全局前 N。默认后端历史 source 筛选仍适用，loaded 页不靠该历史筛选。输出列出每来源扫描数、是否还有页、已检查数、失败与未知数。不会为了凑 N 个结果无限翻页。

每次查询上限 20 秒、100 次只读 RPC、每次最多等待 3 秒、累计响应 2 MiB；不提供完整历史游标。候选跨来源交错选择，以免历史把当前会话或已观察活动完全挤掉。状态和时间不是原子快照，查询期间可能变化。时间并列使用客户端精确 ID 规则，仅对真实活动证据排序；后端 updated_at 可能有未暴露的毫秒精度，参考列表不会用秒精度擅自重排。

观察记录只存 threadId、事件类型、时间和去重哈希，不存消息内容、命令、路径或凭据。持久保留最多 500 个线程、每线程 32 个事件哈希，最新事件保持去重保护；旧记录会被淘汰，因此它不是审计日志。重复通知、重新连接、读列表、读详情、订阅和恢复连接本身不会把活动时间推进到现在。首次看到旧回放也只保存旧生产者时间。无有效生产者时间的事件不会创建活动记录。

只记录当前已连接后端实际发来的事件；不会自动 attach/resume 所有会话来监控，也不保证离线期间活动完整。查询不创建订阅、不发送模型请求、不启动任务、不扫描会话文件。新增旧版 state 字段是可选的，旧数据可继续加载；损坏的活动记录拒绝启动，不将其冒充可靠证据。

Slack 默认只发短摘要；完整有界行与 coverage 在同发送者、同线程的 `result.page` 中。会话标题/cwd 在截断前检查敏感内容，命中时不输出该候选。敏感检测是保守尽力检查，不代表能识别所有秘密。

协议依据：[app-server 文档](https://learn.chatgpt.com/docs/app-server)；[Turn 时间字段](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/app-server-protocol/schema/typescript/v2/Turn.ts)；[thread 元数据同步](https://github.com/openai/codex/blob/3026a8e54e0f48c4d8074cd700f35b0697abc329/codex-rs/thread-store/src/thread_metadata_sync.rs#L180)。当前用户版本是否支持所有元数据字段仍需实机验收；不默认依赖较新 recency_at 排序键。
