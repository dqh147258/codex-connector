# Codex Connector 0.2：本机 Agent 和 Slack 共用已授权的 Codex server

连接器使用官方 `codex app-server proxy` 接入当前账户已配置的共享 daemon。**不使用 Slack 也能工作**：本机 Agent 通过 CLI、stdio MCP 或 Skill 选择 server、创建或绑定会话并读取回复。Slack 可以单独启用，也可以与本机模式并存；Slack 只发送安全元数据、命令回执和可归属到原 Slack 线程的固定状态提醒，不转发原生会话正文或审批细节。快速配置与多 server 示例见[本机 Agent 接入](docs/LOCAL-AGENTS.md)。

> **用户上传的本机验证记录报告：已在 macOS 实机验证共享 daemon 的 WebSocket 握手和只读会话发现，Slack 凭据与 dot 身份核验通过。** 真实活动会话的发送、接管和固定提醒仍待专项验收，不代表所有会话均可管理。完整证据与验收范围见 [runtime report](docs/RUNTIME-VERIFICATION.md)。

## 已实现的边界

- `servers` / `server.list` 只列已注册、当前身份获准的 server 和最近观察状态，不扫描电脑。后续请求用明确的 `serverId`；同名会话、回执、游标不可跨 server 混用。

- Node.js 22+ 持续运行服务器，Slack Socket Mode，无公网入口。
- 仅接受配置的工作区、输入频道、dot 的 **botId + userId + appId**，以及配置的人类 ID；不信任正文里的 `actor` / `approvedBy`。
- 全消息精确起止标记 + JSON；命令、参数、目标实例、重复 ID 均校验。没有任意 shell / RPC 透传。
- 输入频道与输出频道可分离；dot 可按名称唯一解析，保存稳定 user ID。更改名称选择会重新解析，不会继续偷偷 mention 旧对象。
- 共享会话发现、绑定、创建、发送、显式 steer/queue/interrupt；按能力报告无法管理的例外。授权本机客户端可另查可见历史，Slack 不读原生正文。
- 只读文件 `list/stat/read/search`：兼容项目别名；可在本地明确启用绝对路径读取，无需项目别名。保留 OS 权限、敏感路径/内容和输出量限制，默认关闭全系统只读。
- 原生审批和输入必须在原 Codex 界面完成。Slack 只可能收到原线程的固定提醒，不显示原始内容或决策模板。
- 持久命令 inbox 与独立 outbox；发送失败不会重跑 Codex；同一会话输出保序。
- Linux / macOS / Windows 的登录/登录前启动**模板生成**，不自动安装、不提权、不保存系统登录密码。

## 桌面预览界面

Electron 桌面包装正在独立 Draft PR 中验收：图形向导、私密令牌、身份查询、连接诊断与登录启动。桌面包自带 Node/运行依赖，不要求普通用户 npm ci；与下方 CLI 源码安装不同。见 [桌面指南](docs/DESKTOP.md)。未签名/未公证及真实主机验收限制仍适用。

## 1. 安装和配置

```sh
git clone https://github.com/dqh147258/codex-connector.git
cd codex-connector
npm ci
npm run build
node dist/src/cli.js init --mode local  # 仅本机；配置 Slack 用 init --mode slack
```

编辑 `~/.codex-connector/config.json`（Windows 为 `%USERPROFILE%\.codex-connector\config.json`）。`--home PATH` / `CONNECTOR_HOME` 可选择另一个私有目录。模板中的 `*_REPLACE` 等值必须替换，不能原样运行。

以 [`config.example.json`](config.example.json) 为准：

- `instanceId`：给 dot 使用的目标电脑标识。
- `slack.inputChannel`：接收 dot 指令；`outputChannel`：允许显式绑定的输出频道。bot 必须被邀请进相应频道。
- `trustedBots`：精确的 dot 元数据 ID；只填可信 bot。`allowedHumans` 填 Carl 的真实 Slack 用户 ID，不是名字。保留 v2 配置字段 `approvalUsers` 且必须是 `allowedHumans` 的子集；此字段不授予从 Slack 决定原生审批的权限。
- `dot.name`：选择 dot 名称；可同时指定已确认 `dot.userId` 解决重名。输出只 mention 已解析的 ID，不把名称拼成 `@` 文本。
- `projects`：项目别名→绝对路径。默认这些根目录限制只读文件工具；本地启用 `filePolicy.allowAbsolutePaths` 后可省略文件命令的 `root` 并传原生绝对 `path`（可用 `projects:{}`），详见[只读文件](docs/READONLY-FILES.md)；默认会话控制允许根目录及其子目录，发现操作则列出共享 daemon 全部可见会话并给出限制原因。
- `sessionPolicy.allowAllSharedSessions`：仅可在本机配置的显式开关，默认 `false`。设为 `true` 后允许绑定同账户共享 daemon 中项目根以外的会话；**不会扩大 files.* 的 roots**，也不覆盖原会话沙箱。Slack 不能更改此开关。
- `backend.executable`：原生 Codex 可执行文件，或 npm 包的绝对 `bin/codex.js`。Windows 不支持 `.cmd/.bat` shell shim。
- `backend.expectedVersion`：可选的显式版本门槛，**默认省略，不限制 Codex 版本号**；只有你主动填写时才要求完全匹配。已有配置不会被自动修改；要取消旧门槛，删除该字段并重启。连接器仍报告实际版本、检查协议能力；省略不等于保证所有版本兼容。当前历史 schema 证据来自 `0.166.0-alpha.1`，不是默认安装要求。
- `backend.autoStartDaemon`：默认 `false`。由本机操作者设为 `true`，可在版本探测（以及配置了显式门槛时的匹配检查）后调用一次官方 `app-server daemon start`，再连接proxy；15秒超时、失败只报告、不重复启动。不能与显式socketPath同时使用。官方start可能按Codex现有配置准备daemon包/管理更新器，连接器不修改其自动更新策略；不会显式执行stop/update或提权。
- `backend.socketPath`：可选；通常省略，由 **Codex 自己**选择默认共享 socket，连接器不猜路径。

**共享 daemon 必须在同一非管理员 OS 账户下可用。** 默认需要先启动；可由操作者选择上述冷启动开关，再结合系统启动模板。连接器从不自动执行 `daemon stop`，不抢占 `--no-daemon` 独立进程，不读 rollout/session 文件。若默认 daemon 不可用，`capabilities` 显示失败，仍可用 help/只读文件工具；不会假装接管成功。

### Slack App 与令牌（仅启用 Slack 时）

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

`id` 长度 8–128；同一真实主体重试必须保留 ID 和相同内容，不同动作使用新 ID。人类与 bot 的 ID 空间隔离。重复/冲突不重新执行。

可本地生成准确消息：

```sh
node dist/src/cli.js envelope --name session.list --params '{"project":"demo","limit":20}'
node dist/src/cli.js help --command session.create
```

完整 help 由运行时**同一命令 schema**生成，包含参数、默认值、例子、错误、权限和能力。当前命令：

| 类别 | 命令 |
|---|---|
| 说明 | `help`、`capabilities`、`server.list` |
| 会话 | `session.list/recent/info/delivery/create/attach/send/steer/queue/interrupt/reply` |
| 观察 / 分页 | `session.subscribe/subscriptions/unsubscribe`、`result.page/next` |
| 文件只读 | `files.list/stat/read/search` |

`session.reply` 是显式的操作者自写回复，不调用模型、不拉取历史、不修改会话绑定。只发送你有权分享的内容，不要用它转贴本应留在 Codex 的原生正文。文件工具没有写入、删除、执行命令能力；服务管理也不在远程命令清单中。

## 3. 绑定已有默认会话

1. `session.list {"limit":20}` 分别分页读取共享 daemon 当前 loaded ID 与已索引交互历史（不扫描会话文件），返回 `manageable` / `reason`；可加 `project` 过滤。每来源最多 `limit` 条，合并后可达两倍；有 `nextCursor` 就继续分页，不能把第一页当全部。`loaded:true` 是读取时已加载观察，stored-only 为未知而非断言未加载；元数据不可读仍保留 ID，并标记 `METADATA_UNAVAILABLE`。桌面「会话列表」可只读刷新/逐页加载、去重，不自动恢复或读取内容。
2. 选定明确的 `threadId`，发送 `session.attach {"threadId":"...","project":"demo"}`。对于项目外会话，先由操作者在本机启用 `sessionPolicy.allowAllSharedSessions` 并重启，再用 `session.attach {"threadId":"..."}`；无需把外部目录加入文件工具 roots。
3. 返回 `sessionId`。首次 Slack 绑定使用发起命令的原 Thread（顶层命令用该消息自身作为根），并在其中 mention dot；已有绑定不会移动。本机绑定不需要 Slack 目标；只有操作者明确要求绑定到 Slack 时才给出已配置输出频道内可读取的 `outputThreadTs`。
4. 用同一 `sessionId` 发送后续命令：

```json
{"command":"session.send","params":{"sessionId":"...","text":"解释当前进展"}}
{"command":"session.queue","params":{"sessionId":"...","text":"当前任务结束后检查测试","resume":false}}
{"command":"session.steer","params":{"sessionId":"...","turnId":"...","text":"改为先检查类型错误"}}
{"command":"session.interrupt","params":{"sessionId":"...","turnId":"..."}}
```

上面只展示 command/params；实际必须放入完整 envelope。`session.info` 提供近期 turn ID/status。`send` 检查输入能力后使用 `thread/queue/add` + `thread/queue/start`，不通过可能隐式 steer 的 `turn/start`。`queue/add` 可能在响应前唤醒并消费消息，因此 `startError` 只能说明启动请求未获确认，不能断言消息仍在队列或没有收到。发送结果分别报告队列接纳、启动请求和关联 turn 的执行状态；用 `session.delivery {sessionId,workId}` 只读核对最新证据。不重复入队也不悄悄改变正在运行的 turn；当前版本缺少 queue API 时明确失败，不回退。已知忙碌时使用带精确 turn ID 的 `steer` 或 queue。完整状态语义、并发限制和验证方式见 [SESSION-DELIVERY.md](docs/SESSION-DELIVERY.md)。Codex 版本/运行时可能拒绝子代理、独立 `--no-daemon`、特殊来源或不能直接输入的会话；会明确显示 `DIRECT_INPUT_UNAVAILABLE` 等错误。

**Slack 不传原生会话正文。** 绑定、订阅、关闭本机 API 或已知发送者都不能证明同一原生会话没有被其他客户端输入过。Slack 的历史正文、概览摘录、正文搜索、旧分页与历史重放均不可用；收到 `NATIVE_CONTENT_LOCAL_ONLY` 表示 Slack 不提供这一功能，不是没有历史。用原 Codex 界面，或在本机入口启用时用授权本机 API 读可见回复。

## 4. 原生审批和输入怎么处理

回原 Codex 界面查看完整请求并亲自处理。Slack 的固定提示不包含命令、文件差异、问题、选项或决定模板；Slack 和本机 Connector API 都不接收原生批准或输入答复；`LOCAL_ACTION_REQUIRED` 指向原 Codex 界面。

连接器提醒到期时，只把自身记录标为“已过期”。如果仍能核对原 Slack 来源，可发一条固定提醒，请回原 Codex 界面查看；不补读正文，也不发送拒绝、答复或中断。用户可能已在本机回答并继续工作，因此到期不代表原生请求已解决，也不代表 Codex 已停止。

## 5. Codex Skill / 本地 API

从 [本机 Agent 指南](docs/LOCAL-AGENTS.md) 选择 CLI、stdio MCP 或 [Skill](skills/codex-connector/SKILL.md)。例如：

```sh
node /ABS/connector/dist/src/cli.js servers
node /ABS/connector/dist/src/cli.js command --name session.list --server default --params '{"view":"loaded","limit":5}'
node /ABS/connector/dist/src/cli.js receipt --server default --work-id WORK_ID
```

将 `WORK_ID` 换成上一步返回的 `result.id`。接纳回执不代表模型完成。已绑定会话用 `events` 获取本地最终回复；新 Agent 请配独立权限令牌，不要共享操作者的 `api.token`。用于发送文字的参数建议从 UTF-8 JSON 文件或标准输入读取。

API 只监听 `127.0.0.1`，需要私有 token，拒绝浏览器 Origin / 异常 Host。CLI 使用独立 direct HTTP Agent，不会把 bearer token 交给环境 HTTP_PROXY；这也意味着仅允许代理、禁止直连 localhost 的 Codex 沙箱中，CLI 不保证可用。必须由用户审查合法访问设置，不关闭沙箱绕过。**本地 API 不接受 approval/input 决定**；Skill 不能用 owner token 自己批准。

0.1 的 `mailbox/read/ack` 和 managed-owned-only 设计已替换，不自动把旧 state/config 改写成 v2。备份旧目录、使用新的 `--home` 配置；不要以新版本覆盖运行中的旧 daemon。

## 6. 持久性、恢复、开机启动

- `status` 查看 capability、绑定、work/outbox/pending 元数据。
- crash 时 executing→uncertain、sending→uncertain、pending→stale；不自动重放副作用。
- 只读查询不会因为等待抉择就开始另一轮操作；原生决定仍在 Codex 界面处理。
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

测试使用 fake Slack、采用真实 WebSocket 帧的 fake shared-daemon protocol，包含严格消息边界、身份、重放、文件逃逸、审批错配/过期/敏感范围、断连、不确定状态、outbox、真实 CLI 本地 HTTP 及三系统模板。用户上传的本机记录报告已在 macOS 验证真实 Slack Socket Mode、频道读取和默认共享 daemon 的只读会话发现；Windows、Slack 指令收发/mention、实际活动会话接管和固定状态提醒仍待实机验收。此处本机记录不包含 CI；当前桌面预览另有 macOS arm64/x64 Actions 构建与 mock 测试。

详细：[实现计划](PLAN.md) · [安全边界](docs/SECURITY.md) · [协议说明](docs/PROTOCOL.md) · [实际能力证据](docs/RUNTIME-VERIFICATION.md)

### 群聊回复不会刷到频道顶层

命令成功、失败和格式错误都回复发起命令的原 Thread；顶层命令以该消息自身建立回复 Thread。异步状态通知只去该操作可核实的原 Slack Thread，不把事件送给其他观察者或本机操作创建的绑定。找不到有效目的 Thread 时拒绝发送，不回退到群聊顶层。

本地新建或绑定默认不发 Slack，无需 `outputThreadTs`。仅操作者明确要求 Slack 绑定时提供已配置输出频道内的根时间戳；Connector 先验证可读取性。MCP 不接受该字段。完整边界见 [协议说明](docs/PROTOCOL.md#reply-destination-and-explicit-address)。

## 简洁 Slack 输出与关键消息订阅

Slack 默认 `session.list` 只查 loaded、每来源最多 10 条；`view:active` 从当前 loaded 元数据筛选，历史单独用 `view:history`。使用 `result.next` 获取下一页，`result.page` 显式读取短期、同身份同线程的详情，避免自动 JSON 刷屏。`session.subscribe` / `session.unsubscribe` 默认管理固定状态提醒，取消不会停止 Codex。双入口下，本机操作者可另外确认向这一确切 Slack 线程分享未来合规的 Codex 回复和问题（不分享旧历史，不代答）。完整边界见 [输出与订阅](docs/SLACK-OUTPUT.md)。

提供两份可手动安装/阅读的 Skill：[Codex 本地](skills/codex-connector/SKILL.md) 与 [dot Slack 操作](skills/dot-slack-connector/SKILL.md)。没有自动安装到用户电脑或修改 dot 内部指令。

## 定位会话与查看内容

Slack 使用 `session.list` 定位有明确 ID 的候选会话，或用 `session.recent {"limit":5}` 根据生产者生命周期时间查看有界候选。当前 idle 也可入选；没有真实活动时间的记录单列为后端更新参考，不等于执行。见 [SESSION-RECENT.md](docs/SESSION-RECENT.md)。有多个候选时请让操作者在原 Codex 界面核对，不靠猜测或搜索原生正文。

已有授权本机绑定时，可以通过本机 `session.history`、`events` 或对应 MCP 工具读取有界可见历史和最终事件。只读内容不授予查看原生审批细节或作决定的权限，不应再复制进 Slack。详情见[本机 Agent 接入](docs/LOCAL-AGENTS.md)。

## 远程屏幕截图（默认关闭）

截图是独立且默认关闭的功能，不属于元数据通知。画面可能包括原生对话、审批提示和其它应用，且不会脱敏。要求全程只向 Slack 发送元数据的环境应保持关闭。经本机操作者单独启用并满足系统和 Slack 权限时，`screen.capture` 才把选定界面的 JPEG 发到原请求线程；不会后台截屏。见 [SCREENSHOTS.md](docs/SCREENSHOTS.md)。
