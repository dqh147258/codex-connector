# Codex Connector 0.2 — 本机共享 Codex server ↔ Slack dot

这是一次**共享 daemon 架构重构**：不再只管理连接器自己启动的独立 app-server。连接器使用官方 `codex app-server proxy` 接入当前账户的默认共享 daemon；列出、显式绑定并管理它可见的会话。一个绑定会话对应一个输出 Slack thread，所有输出 `@` 配置并验证过的 dot 用户 ID。

> **用户上传的本机验证记录报告：已在 macOS 实机验证共享 daemon 的 WebSocket 握手和只读会话发现，Slack 凭据与 dot 身份核验通过。** 真实活动会话的发送、接管和审批回放仍待专项验收，不代表所有会话均可管理。完整证据与验收范围见 [runtime report](docs/RUNTIME-VERIFICATION.md)。

## 已实现的边界

- Node.js 22+ 持续运行服务器，Slack Socket Mode，无公网入口。
- 仅接受配置的工作区、输入频道、dot 的 **botId + userId + appId**，以及配置的人类 ID；不信任正文里的 `actor` / `approvedBy`。
- 全消息精确起止标记 + JSON；命令、参数、目标实例、重复 ID 均校验。没有任意 shell / RPC 透传。
- 输入频道与输出频道分离；dot 可按名称唯一解析，保存稳定 user ID。更改名称选择会重新解析，不会继续偷偷 mention 旧对象。
- 共享会话发现、绑定、创建、信息/文本历史、发送、显式 steer/queue/interrupt；按能力报告无法管理的例外。
- 只读文件 `list/stat/read/search`：兼容项目别名；可在本地明确启用绝对路径读取，无需项目别名。保留 OS 权限、敏感路径/内容和输出量限制，默认关闭全系统只读。
- 审批/输入精确绑定 **requestId + epoch + sessionId + turnId**；过期、重启、重复、错线程拒绝；不自动批准。
- 持久命令 inbox 与独立 outbox；发送失败不会重跑 Codex；同一会话输出保序。
- Linux / macOS / Windows 的登录/登录前启动**模板生成**，不自动安装、不提权、不保存系统登录密码。

## 桌面预览界面

Electron 桌面包装正在独立 Draft PR 中验收：图形向导、私密令牌、身份查询、连接诊断与登录启动。桌面包自带 Node/运行依赖，不要求普通用户 npm ci；与下方 CLI 源码安装不同。见 [桌面指南](docs/DESKTOP.md)。未签名/未公证及真实主机验收限制仍适用。

## 1. 安装和配置

```sh
git clone https://github.com/dqh147258/codex-connector.git
cd codex-connector
# 若重构 PR 尚未合并，切到其分支：
git checkout refactor/shared-daemon-slack-server
npm ci
npm run build
node dist/src/cli.js init
```

编辑 `~/.codex-connector/config.json`（Windows 为 `%USERPROFILE%\.codex-connector\config.json`）。`--home PATH` / `CONNECTOR_HOME` 可选择另一个私有目录。模板中的 `*_REPLACE` 等值必须替换，不能原样运行。

以 [`config.example.json`](config.example.json) 为准：

- `instanceId`：给 dot 使用的目标电脑标识。
- `slack.inputChannel`：接收 dot 指令；`outputChannel`：输出和人类决定的目标频道。bot 必须被邀请进两个频道。
- `trustedBots`：精确的 dot 元数据 ID；只填可信 bot。`allowedHumans` / `approvalUsers` 填 Carl 的真实 Slack 用户 ID，不是名字。
- `dot.name`：选择 dot 名称；可同时指定已确认 `dot.userId` 解决重名。输出只 mention 已解析的 ID，不把名称拼成 `@` 文本。
- `projects`：项目别名→绝对路径。默认这些根目录限制只读文件工具；本地启用 `filePolicy.allowAbsolutePaths` 后可省略文件命令的 `root` 并传原生绝对 `path`（可用 `projects:{}`），详见[只读文件](docs/READONLY-FILES.md)；默认会话控制允许根目录及其子目录，发现操作则列出共享 daemon 全部可见会话并给出限制原因。
- `sessionPolicy.allowAllSharedSessions`：仅可在本机配置的显式开关，默认 `false`。设为 `true` 后允许绑定同账户共享 daemon 中项目根以外的会话；**不会扩大 files.* 的 roots**，也不覆盖原会话沙箱。Slack 不能更改此开关。
- `backend.executable`：原生 Codex 可执行文件，或 npm 包的绝对 `bin/codex.js`。Windows 不支持 `.cmd/.bat` shell shim。
- `backend.expectedVersion`：可选的显式版本门槛，**默认省略，不限制 Codex 版本号**；只有你主动填写时才要求完全匹配。已有配置不会被自动修改；要取消旧门槛，删除该字段并重启。连接器仍报告实际版本、检查协议能力；省略不等于保证所有版本兼容。当前历史 schema 证据来自 `0.166.0-alpha.1`，不是默认安装要求。
- `backend.autoStartDaemon`：默认 `false`。由本机操作者设为 `true`，可在版本探测（以及配置了显式门槛时的匹配检查）后调用一次官方 `app-server daemon start`，再连接proxy；15秒超时、失败只报告、不重复启动。不能与显式socketPath同时使用。官方start可能按Codex现有配置准备daemon包/管理更新器，连接器不修改其自动更新策略；不会显式执行stop/update或提权。
- `backend.socketPath`：可选；通常省略，由 **Codex 自己**选择默认共享 socket，连接器不猜路径。

**共享 daemon 必须在同一非管理员 OS 账户下可用。** 默认需要先启动；可由操作者选择上述冷启动开关，再结合系统启动模板。连接器从不自动执行 `daemon stop`，不抢占 `--no-daemon` 独立进程，不读 rollout/session 文件。若默认 daemon 不可用，`capabilities` 显示失败，仍可用 help/只读文件工具；不会假装接管成功。

### Slack App 与令牌

导入 [`slack-app-manifest.json`](slack-app-manifest.json)，开启 Socket Mode，安装到工作区；创建带 `connections:write` 的 app-level token。daemon 终端需要：

```sh
export SLACK_APP_TOKEN='xapp-你的令牌'
export SLACK_BOT_TOKEN='xoxb-你的令牌'
node dist/src/cli.js doctor
node dist/src/cli.js start
```

PowerShell：

```powershell
$env:SLACK_APP_TOKEN = 'xapp-你的令牌'
$env:SLACK_BOT_TOKEN = 'xoxb-你的令牌'
node dist/src/cli.js doctor
node dist/src/cli.js start
```

令牌只放本机私有环境，不发给 dot、不写入 Git。`doctor` 不启动 Codex。实际 `start` 会检查 `--version`，按本机可选开关确保官方共享daemon启动，再启动 **proxy 客户端**；不是用 Codex写代码，也不是静默创建独立 app-server。没有真实 Slack 凭据时不要声称已连通。

如果从另一个 Codex/代理环境启动，检查继承的 `CODEX_HOME` 是否对应目标共享 daemon。macOS/Linux 使用普通账户默认目录时，可运行 `env -u CODEX_HOME node --env-file="$HOME/.codex-connector/service.env" dist/src/cli.js start`；使用自定义 Codex 目录时应保留或显式设置对应的 `CODEX_HOME`。官方 `proxy` 只转发字节，连接器在其 stdio 管道上执行 WebSocket 握手和帧编解码。

## 2. dot 发指令：整条消息必须是这个格式

标记使用纯 ASCII 单词，避免 Slack `<`/`>` 转义。**不带代码围栏、额外说明或重复标记。** 可选地址为开头精确的 Connector 自身 `<@USER_ID>` 加一个空格、LF 或 CRLF；已认证 bot 还兼容同一 ID 的 `<@USER_ID|显示名>` 和 `&lt;@USER_ID&gt;` 地址表示，显示名不参与授权。之后仍必须是完整严格 envelope，详见 [协议边界](docs/PROTOCOL.md)。 以下代码块只是文档展示，实际发送不要包括反引号：

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"request-20261102-0001","target":"my-computer","command":"help","params":{}}
CODEX_CONNECTOR_COMMAND_END
```

`id` 长度 8–128；同一真实主体重试必须保留 ID 和相同内容，不同动作使用新 ID。人类与 bot 的 ID 空间隔离，dot 不能先占用审批模板 ID 来阻止 Carl 回答。重复/冲突不重新执行。

可本地生成准确消息：

```sh
node dist/src/cli.js envelope --name session.list --params '{"project":"demo","limit":20}'
node dist/src/cli.js help --command session.create
```

完整 help 由运行时**同一命令 schema**生成，包含参数、默认值、例子、错误、权限和能力。当前命令：

| 类别 | 命令 |
|---|---|
| 说明 | `help`、`capabilities` |
| 会话 | `session.list/info/history/delivery/create/attach/send/steer/queue/interrupt/reply` |
| 审批/输入 | `approval.list/respond`、`input.respond` |
| 文件只读 | `files.list/stat/read/search` |

`session.reply` 不调用模型；本地/Skill 调用向已有绑定 thread 发进度，Slack 调用则回复调用者所在 thread，不修改会话绑定。文件工具没有写入、删除、执行命令能力；服务管理也不在远程命令清单中。

## 3. 绑定已有默认会话

1. `session.list {"limit":20}` 分别分页读取共享 daemon 当前 loaded ID 与已索引交互历史（不扫描会话文件），返回 `manageable` / `reason`；可加 `project` 过滤。每来源最多 `limit` 条，合并后可达两倍；有 `nextCursor` 就继续分页，不能把第一页当全部。`loaded:true` 是读取时已加载观察，stored-only 为未知而非断言未加载；元数据不可读仍保留 ID，并标记 `METADATA_UNAVAILABLE`。桌面「会话列表」可只读刷新/逐页加载、去重，不自动恢复或读取内容。
2. 选定明确的 `threadId`，发送 `session.attach {"threadId":"...","project":"demo"}`。对于项目外会话，先由操作者在本机启用 `sessionPolicy.allowAllSharedSessions` 并重启，再用 `session.attach {"threadId":"..."}`；无需把外部目录加入文件工具 roots。
3. 返回 `sessionId`。首次 Slack 绑定使用发起命令的原 Thread（顶层命令用该消息自身作为根），并在其中 mention dot；已有绑定不会移动。本地/Skill 首次绑定需要 `outputThreadTs` 指定配置输出频道内可读取的已有 Thread。
4. 用同一 `sessionId` 发送后续命令：

```json
{"command":"session.send","params":{"sessionId":"...","text":"解释当前进展"}}
{"command":"session.queue","params":{"sessionId":"...","text":"当前任务结束后检查测试","resume":false}}
{"command":"session.steer","params":{"sessionId":"...","turnId":"...","text":"改为先检查类型错误"}}
{"command":"session.interrupt","params":{"sessionId":"...","turnId":"..."}}
```

上面只展示 command/params；实际必须放入完整 envelope。`session.info` 提供近期 turn ID/status。`send` 检查输入能力后使用 `thread/queue/add` + `thread/queue/start`，不通过可能隐式 steer 的 `turn/start`。`queue/add` 可能在响应前唤醒并消费消息，因此 `startError` 只能说明启动请求未获确认，不能断言消息仍在队列或没有收到。发送结果分别报告队列接纳、启动请求和关联 turn 的执行状态；用 `session.delivery {sessionId,workId}` 只读核对最新证据。不重复入队也不悄悄改变正在运行的 turn；当前版本缺少 queue API 时明确失败，不回退。已知忙碌时使用带精确 turn ID 的 `steer` 或 queue。完整状态语义、并发限制和验证方式见 [SESSION-DELIVERY.md](docs/SESSION-DELIVERY.md)。Codex 版本/运行时可能拒绝子代理、独立 `--no-daemon`、特殊来源或不能直接输入的会话；会明确显示 `DIRECT_INPUT_UNAVAILABLE` 等错误。

**只有显式绑定且仍符合本机会话控制策略的会话会被转发**，不会自动广播其他会话。历史只输出用户/assistant 文本，不输出工具日志、推理、图片或原始本地文件路径；长文本有界截断并保留分页游标。

## 4. Carl → dot → connector 的决定路径

连接器将适合远程处理的原始请求范围、到期时间和完整回答模板发到该会话输出 thread，mention dot。只支持一次请求的 `accept / decline / cancel`，不支持 `acceptForSession`、execpolicy 修改或全局授权。

两条受支持路径：

1. **Carl 直接回同一 thread**：使用模板中的 requestId/epoch/sessionId/turnId，以配置的真实人类账号发送完整决定 envelope。
2. **dot 转交可验证引用**：Carl 的完整决定 envelope 存在于该允许的输出 thread；dot 发送相同决定参数，加上 `humanMessageTs`。连接器独立获取该时间戳的实际 Slack 消息，核对真实人类 ID、未编辑、同 thread、相同请求/决定，再回应 Codex。正文里写“Carl 已同意”、引用一句话或伪造 `approvedBy` 都不算授权。

若 bot token 无法读取这条消息（Slack 的 `conversations.replies` 在部分 token/频道类型下受限），或决定只存在于不可读 DM，则返回 `NEED_VERIFIABLE_HUMAN_DECISION`。请 Carl 直接回原 thread；**不会为了闭环把 dot 升级为可自行批准的代理**。此路径已有 fake integration 测试，真实工作区权限仍待验证。

输入问题按原始 question ID 和选项校验。密码/secret 问题、隐藏/缺失/过长的命令或 diff、宽根目录授权、未知交互请求转为 `LOCAL_ACTION_REQUIRED`，内容不泄露到 Slack，也不自动猜答案。超时的可处理命令/文件审批拒绝；输入超时中断该精确 turn。重连后旧请求失效，只有新连接实际 replay 的请求才能重新决策。

## 5. Codex Skill / 本地 API

复制 `skills/codex-connector/` 到项目 `.agents/skills/codex-connector/`，让现有 Codex 通过本地 CLI 调用命令，见 [Skill](skills/codex-connector/SKILL.md)。例如：

```sh
node /ABS/connector/dist/src/cli.js command --name session.reply --params-file progress.json
node /ABS/connector/dist/src/cli.js status
```

`progress.json` 为 `{"sessionId":"明确的绑定ID","text":"进展"}`。避免把不可信文本拼入 shell，使用 UTF-8 JSON 文件或 stdin。

API 只监听 `127.0.0.1`，需要私有 token，拒绝浏览器 Origin / 异常 Host。CLI 使用独立 direct HTTP Agent，不会把 bearer token 交给环境 HTTP_PROXY；这也意味着仅允许代理、禁止直连 localhost 的 Codex 沙箱中，CLI 不保证可用。必须由用户审查合法访问设置，不关闭沙箱绕过。**本地 API 不接受 approval/input 决定**；Skill 不能用 owner token 自己批准。

0.1 的 `mailbox/read/ack` 和 managed-owned-only 设计已替换，不自动把旧 state/config 改写成 v2。备份旧目录、使用新的 `--home` 配置；不要以新版本覆盖运行中的旧 daemon。

## 6. 持久性、恢复、开机启动

- `status` 查看 capability、绑定、work/outbox/pending 元数据。
- crash 时 executing→uncertain、sending→uncertain、pending→stale；不自动重放副作用。
- 审批和只读查询有独立队列，不会被不确定模型动作卡住。
- 网络发送结果不明时 outbox 暂停同会话后续输出，Codex 不重跑；其他会话可继续。
- 操作者核对实际状态后本地执行：

```sh
node dist/src/cli.js recover --kind command --id WORK_ID
# 确认已经发出，用真实 Slack ts登记；若省略observed-ts表示明确重试，可能重复消息。
node dist/src/cli.js recover --kind outbox --id DELIVERY_ID --observed-ts 1234567890.123456
```

`recover command` 只解除阻塞，不重跑原动作。重启后只有未开始的 queued 工作继续执行。退出只关闭自己的 proxy 连接，不关闭共享 daemon、不替其他客户端中断任务。异常锁文件必须先检查进程再人工清理。

三系统的本地模板生成与手动安装/卸载指引见 [STARTUP.md](docs/STARTUP.md)。**登录启动不等于登录前启动**；Windows S4U、加密 home/keychain、网络和凭据可用性都有真实限制。此实现未安装/启用任何服务，不提供远程 install/uninstall 或自动提权。

## 验证与剩余验收

```sh
npm ci
npm run typecheck
npm test
```

测试使用 fake Slack、采用真实 WebSocket 帧的 fake shared-daemon protocol，包含严格消息边界、身份、重放、文件逃逸、审批错配/过期/敏感范围、断连、不确定状态、outbox、真实 CLI 本地 HTTP 及三系统模板。用户上传的本机记录报告已在 macOS 验证真实 Slack Socket Mode、频道读取和默认共享 daemon 的只读会话发现；Windows、Slack 指令收发/mention、实际活动会话接管和跨客户端审批回放尚未验收。此处本机记录不包含 CI；当前桌面预览另有 macOS arm64/x64 Actions 构建与 mock 测试。

详细：[实现计划](PLAN.md) · [安全边界](docs/SECURITY.md) · [协议说明](docs/PROTOCOL.md) · [实际能力证据](docs/RUNTIME-VERIFICATION.md)

### 群聊回复不会刷到频道顶层

命令成功、失败和格式错误都回复发起命令的原 Thread；顶层命令以该消息自身建立回复 Thread。异步 Codex 输出/审批继续留在既有会话绑定，后续从别的 Thread 查询不会偷偷改绑。找不到有效目的 Thread 时拒绝发送，不回退到群聊顶层。

本地/Skill 新建或首次绑定时，在参数中提供 `outputThreadTs`（配置输出频道中已存在的 Slack Thread 根时间戳）；Connector 验证可读取后才启动新 Codex 会话。已有绑定仍可直接 `session.reply`。完整边界见 [协议说明](docs/PROTOCOL.md#reply-destination-and-explicit-address)。

## 简洁 Slack 输出与关键消息订阅

Slack 默认 `session.list` 只查 loaded、每来源最多 10 条；`view:active` 从当前 loaded 元数据筛选，历史单独用 `view:history`。使用 `result.next` 获取下一页，`result.page` 显式读取短期、同身份同线程的详情，避免自动 JSON 刷屏。`session.subscribe` / `session.unsubscribe` 独立控制关键阶段消息，取消不会停止 Codex。完整边界见 [输出与订阅](docs/SLACK-OUTPUT.md)。

提供两份可手动安装/阅读的 Skill：[Codex 本地](skills/codex-connector/SKILL.md) 与 [dot Slack 操作](skills/dot-slack-connector/SKILL.md)。没有自动安装到用户电脑或修改 dot 内部指令。

## 选定会话的上下文概览

先 `session.list`，再用 `session.overview` 对 1–5 个 Codex threadId 获取首条/最近用户消息与最近可见模型消息的有界摘录；定位后用同一 threadId 调 `session.messages` 只读翻页或显式 `session.subscribe`。无需先绑定/恢复会话，不调用额外模型总结。范围、覆盖不足和 ID 区别见 [会话概览接口](docs/SESSION-OVERVIEW.md)。

### 最近活跃会话

`session.recent {"limit":5}` 根据生产者生命周期时间列出有界候选中的最近活动；当前 idle 也可入选。没有真实活动时间的记录单列为后端更新参考，不混称执行。只查元数据、不自动接管或订阅，也不会把查询/重连算成活跃。随后用精确 Codex threadId 查询概览和对话。完整范围、时间来源和限制见 [SESSION-RECENT.md](docs/SESSION-RECENT.md)。

## 远程屏幕截图（默认关闭）

桌面版本新增 `screen.list` 与 `screen.capture {"displayId":"all"}` / 精确屏幕 ID：一次截图作为 JPEG 上传至原 Slack 线程。需要本机显式启用、系统屏幕录制权限和 Slack `files:write`；不逐次确认、不后台截屏。画面不自动脱敏。Wayland/PipeWire 不支持可靠的全部/指定屏幕映射，纯 CLI 无截图 provider。设置、风险、平台限制与验收说明见 [SCREENSHOTS.md](docs/SCREENSHOTS.md)。
