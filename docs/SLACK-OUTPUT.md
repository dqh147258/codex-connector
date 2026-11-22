# Slack 输出、分页与观察边界

**本版在仅 Slack 和双入口模式都不转发原生 Codex 正文。** 官方共享协议无法原子确认同一轮次没有其他客户端输入；绑定、订阅或关闭本机 API 都不能改变这点。需要回复或正文时去原 Codex 界面，或用独立获授权的本机 `session.history` / `events`。不要用本机 API 或文件工具代为分享到 Slack。

## 安全元数据和命令结果

- `server.list` 列出已配置且当前身份获准的目标和缓存状态，不探测后端；`session.list` 在 Slack 默认只查 loaded、每来源最多 10 条，按需用 active / history / all 视图。历史视图是**会话元数据**，不是对话正文。loaded 时点不等于可控制，无法读取的条目也不等于 idle。
- `session.recent` 按有证据的生命周期时间给出有界排名；更新时间是另列参考。详情可查看原有安全结果，不能借此补播正文。
- `result.page {"resultId":"…","page":1}` 只读取同身份同频道/线程的原安全快照，受授权和有效期约束；若有实际返回的继续入口，`result.next` 继续支持的安全元数据查询。二者都不能解封旧快照、恢复隐藏字段或重复执行原命令。
- `session.history`、`session.overview`、`session.messages`、`session.search` 不向 Slack 提供正文、摘录、匹配或继续入口；`NATIVE_CONTENT_LOCAL_ONLY` 是边界，不是读到空结果。原生生成的标题、错误正文、工具和推理信息不作为 Slack 输出。旧的正文条目不会借重连、分页、排队或恢复重新发出；已经发到 Slack 的消息不自动撤回。
- 命令结果、错误和显式回复只送回已授权线程，不回退成频道顶层播报。操作者显式 `session.reply` 只发送所输入的自写文字到获准绑定，不调用模型或获取原生正文；不要将其用作手动转贴通道。

## 固定状态观察

`session.subscribe {"threadId":"EXACT_CODEX_THREAD_ID"}` 验证明确、已加载并在授权范围内的共享会话。它不创建控制绑定，不发送输入、不代表当前正执行。只有能归属到原 Slack 操作、通过当前范围检查且目的地仍是该操作原 Slack 线程时，才可能收到固定轮次状态或交互提醒；订阅其他人的线程不会获得操作的通知。不会转发 commentary、partial_answer、final_answer 正文，也不补读或补播历史。

- `session.subscriptions` 列本认证身份在当前 Slack 线程内的订阅。持久化的开启状态不是当前 epoch 观察就绪的证明；断开、后端拒绝或项目权限变化时，以实际就绪与错误为准。
- `session.unsubscribe {"subscriptionId":"…"}` 只取消同身份、同 Slack 线程的观察，不停止 Codex 或任何已运行轮次。已经开始发送的通知无法保证撤回；取消也不会切换为旧自动正文路由。
- 非原子、受限的观察路径不承诺覆盖断线期间的事件，也不代表所有原生会话都可见。精确发送状态见 [发送证据](SESSION-DELIVERY.md)，不要通过新请求 ID 重发来消除不确定状态。

## 原生审批和输入

Slack 最多发出固定的“回原 Codex 界面处理”提示，没有命令、diff、权限范围、问题、选项或决定模板。所有原生决定由用户在原生界面处理（`LOCAL_ACTION_REQUIRED`）。连接器提醒到期只更新其本机记录，可向仍明确授权的原线程发一条固定提醒；不会补读、拒绝、答复或中断原生工作。
