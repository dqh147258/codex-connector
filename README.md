# codex-connector

本地 Codex ↔ Slack thread 连接器，附带真正调用连接器 CLI 的 **Codex Skill**。

- **一个 connector session 对应一个 Slack thread**，映射和消息队列保存在本机。
- Slack Socket Mode：本机主动连接 Slack，**不需要公网端口或隧道**。
- Slack 发起新的 Codex session；同一 thread 后续消息按顺序交给同一 session；最终回答回到原 thread。
- 已经打开的 Codex 会话可以通过 Skill 创建 thread、发消息、读取/确认 thread 回复。
- 默认只读沙箱、显式用户/频道/工作区白名单、不自动批准操作、不执行 Slack 提供的 shell 命令。

## 两种模式（重要）

| 模式 | 用途 | Slack 消息如何进入 Codex |
|---|---|---|
| `managed` | 由连接器创建并独占管理的 Codex app-server session | 自动排队执行，最终回答自动回复 thread |
| `mailbox` | 现有 TUI / IDE Codex 会话通过 Skill 使用连接器 | Skill 主动 `read`，处理后 `send` + `ack`；**不会强制唤醒或注入忙碌会话** |

不扫描 Codex 的 sessions 文件，不猜测当前 session ID，不通过 `exec resume` 抢占现有会话。现有会话要无人值守地自动响应，需要迁移到新的 managed 会话；此版本不实现共享 daemon 的 `codex queue`。

## 支持平台与验证范围

目标运行环境：**Windows、Linux、macOS，Node.js 22+**。使用平台路径、无 shell 的进程启动、Windows JS launcher / native exe 支持；Windows 关闭本连接器启动的进程树，POSIX 关闭独立进程组。

本次在 Linux / Node 24 环境通过 build、typecheck、单元和本地假协议集成测试。**没有连接真实 Slack、没有运行真实 Codex，也没有在真实 Windows/macOS 主机做端到端测试**。协议接口仍应在首次真实运行前核对本机 Codex 版本。没有配置 CI 或后台系统服务。

## 1. 安装

先按 OpenAI 官方说明安装并登录 Codex CLI（`codex app-server` 必须可用），安装 Node.js 22+。不要把 Codex 登录文件复制给本项目。

```sh
git clone https://github.com/dqh147258/codex-connector.git
cd codex-connector
npm ci
npm run build
node dist/src/cli.js init
```

后续可以始终使用 `node /完整路径/codex-connector/dist/src/cli.js …`。若希望直接使用 `codex-connector`，可在仓库目录运行 `npm link`（这会修改本机 npm 的命令链接，需要你选择执行）。

配置目录默认：

- Linux/macOS：`~/.codex-connector/`
- Windows：`%USERPROFILE%\.codex-connector\`
- 用环境变量 `CONNECTOR_HOME` 覆盖；daemon 和 Skill/CLI 必须使用同一个目录。

`init` 只创建配置模板和随机本地 API token，不打印 token，不创建 Slack 应用、不安装系统服务。配置目录包含私密对话和 token，请勿放进仓库、共享盘或云同步目录。

## 2. 创建 Slack App

1. 在 Slack 的 **Your Apps → Create New App → From an app manifest** 导入 `slack-app-manifest.json`，选择自己的工作区。
2. 确认 Socket Mode 已打开。在 Basic Information → App-Level Tokens 创建带 `connections:write` scope 的 app token（`xapp-…`）。
3. 安装应用到工作区，取得 Bot User OAuth Token（`xoxb-…`）。
4. 将 bot 邀请进目标频道；私有频道也要邀请。
5. 获取 **工作区 ID `T…`、允许操作的用户 ID `U…`、频道 ID `C…`/`G…`**，写入配置。只允许这里列出的用户触发会话；不要使用 `*`。

清单只订阅公开/私有频道消息，不支持 DM、附件下载、语音或 Slack slash commands。消息命令是普通文本 `!codex new …`。

## 3. 编辑本地配置

编辑配置目录下的 `config.json`（不要把真实配置提交到 Git）：

```json
{
  "teamId": "T0123456789",
  "allowedUsers": ["U0123456789"],
  "allowedChannels": ["C0123456789"],
  "projects": { "demo": "/home/me/projects/demo" },
  "port": 17381,
  "codexExecutable": "/absolute/path/to/codex",
  "sandbox": "read-only"
}
```

`projects` 是固定别名→绝对目录白名单。Slack 不能传任意目录、可执行文件、启动参数或环境变量。

### Linux / macOS

用 `command -v codex` 查实际路径，填入 `codexExecutable`。若路径为 npm 的 JavaScript launcher，也支持其实际绝对 `bin/codex.js` 路径。项目路径填写对应系统的绝对路径。

```sh
# 只在 daemon 的终端设置；不要写进 Skill、Slack 或 Git。
export SLACK_APP_TOKEN='xapp-你的令牌'
export SLACK_BOT_TOKEN='xoxb-你的令牌'
node dist/src/cli.js doctor
node dist/src/cli.js start
```

### Windows（PowerShell，原生运行）

使用 Node.js 22+ 和支持 Windows 的 Codex 安装。**不要填 `codex.cmd` / `.bat`**：它们需要 shell；本连接器不会为了兼容而打开 shell 执行。

若用 npm 安装 `@openai/codex`，执行 `npm root -g` 找全局 npm 目录，检查该目录下 `@openai\codex\bin\codex.js` 确实存在；将它的完整路径写入配置。连接器用当前 Node 直接运行该 JS launcher。也可以填官方 native `codex.exe` 的绝对路径。

```json
{
  "teamId": "T0123456789",
  "allowedUsers": ["U0123456789"],
  "allowedChannels": ["C0123456789"],
  "projects": { "demo": "C:\\Users\\me\\projects\\demo" },
  "port": 17381,
  "codexExecutable": "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js",
  "sandbox": "read-only"
}
```

以上用户目录只是例子，以 `npm root -g` 和实际存在的文件为准。

```powershell
$env:SLACK_APP_TOKEN = 'xapp-你的令牌'
$env:SLACK_BOT_TOKEN = 'xoxb-你的令牌'
node dist/src/cli.js doctor
node dist/src/cli.js start
```

Windows 文件权限由账户 ACL 控制；确认配置目录仅自己的账户/系统/管理员可访问。POSIX 下创建目录 `0700`、token/state `0600`。Windows 也可使用 WSL2，但此时 Node、Codex、项目路径、daemon 和 Skill 都应在同一 WSL 环境，不能混用宿主路径或 token 目录。

### 沙箱与审批

默认 `read-only`。需要修改代码时，**由你手动**将 `sandbox` 改为 `workspace-write`，重启；显式 writableRoots 为该项目，临时目录是否可写还取决于 Codex/平台默认规则；默认关闭 Codex 沙箱网络访问。Codex 模型与 reasoning effort 不被连接器修改，沿用你本机的实际配置。继承本机 Codex approval policy，不设置 `never`、`full-auto`、`danger-full-access` 或自动批准。

**已有权限配置的高级用户可显式选择 `"sandbox": "inherit"`**：连接器将同时省略 thread 的 `sandbox` 和 turn 的 `sandboxPolicy`，不另设 approval policy，完全交给你已配置的 Codex 权限策略/受管要求。这不等于自动限制到 localhost；继承的配置可能更宽，必须由你先审查并测试，不能用它绕过组织策略。连接器不会自动创建 profile、打开网络、修改权限配置。

如果希望 managed Codex **通过 Skill 主动发进度**，默认 network-off/read-only 可能阻止 CLI 的 localhost HTTP；此时最终回答自动转发仍可用。需要先在你当前 Codex 版本中配置并验证一个允许此 CLI 访问 `127.0.0.1` 的窄权限方案，再选 `inherit`。官方当前提供 permission profile + active network proxy 的主机白名单，但域规则**不按端口隔离**，且 Node 客户端是否使用代理必须实测。本版本 CLI 默认直连 loopback，不自动把 bearer token 发给环境中的 HTTP_PROXY；只配置代理域白名单并不证明直连可用。见 [权限文档](https://learn.chatgpt.com/docs/permissions) 和 [配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。如果 profile 要求显式选择或 HTTP proxy，而无法验证本 CLI 的连接，不要降低沙箱强行运行；继续使用 mailbox 的已许可运行环境，或保持自动最终回答模式。

涉及审批或交互输入时，本版本拒绝/中断并暂停该队列，提示回本机检查。没有远程“全部批准”。Skill 的 localhost CLI 访问若被当前 Codex 沙箱阻止，需你批准合适的访问设置；连接器不是绕过沙箱的通道。

## 4. 在 Slack 调用本机 Codex

保持 daemon 前台运行，然后在允许的频道发：

```text
!codex new demo 请先解释这个项目的结构，不要修改文件
```

这条消息就是新 thread 的根。Codex 回答在该 thread 下；继续在 **同一个 thread** 回复即可延续同一个 managed session。多个 session 可以并行，每个 session 内严格串行。仅转发最终 assistant 文本，不转发推理、工具日志、原始错误或命令输出。长回复分块、按频道限速发送；不做逐 token 直播。

## 5. 让已有 Codex 通过 Skill 访问连接器

把 `skills/codex-connector/` 复制到要使用它的项目的 `.agents/skills/codex-connector/`，或按当前 Codex 官方说明放入用户级 skills 目录。重开/刷新相应会话，让 Codex 识别 Skill。确保 CLI 在 PATH 上，或者告诉 Codex 仓库中 `dist/src/cli.js` 的绝对路径。

对 Codex 说：

> 使用 codex-connector Skill，给当前会话在 C0123456789 创建 Slack thread，项目别名 demo。把进度和回答发到这个 thread。

Skill 实际使用：

```sh
codex-connector create --project demo --channel C0123456789 --mode mailbox --title "当前 Codex 会话"
# 保存返回的 result.id，后续始终使用同一 ID
codex-connector send --session SESSION_ID --text "当前进展"
codex-connector read --session SESSION_ID
codex-connector ack --session SESSION_ID --jobs JOB_ID
codex-connector status --session SESSION_ID
```

多行/不可信文本用 `--text-file PATH`，stdin 可用 `--text-file -`。**不要把 Slack 文本拼进 shell 命令。** mailbox 是主动收取模式；用户在 Slack 回复后，已有 Codex 需要调用 `read` 才能接收，不会被后台偷偷抢占。

## 运维与恢复

- `status [--session ID]`：查看映射和队列元数据，不输出消息正文。
- `read --session ID`：查看待处理 inbox 正文；`ack` 仅用于 mailbox。
- `ask --session ID --text …`：本地向该 session 排队发一条消息。
- `bind --session ID --project demo --channel C… --thread 123.456`：把用户指定的现有 Slack 根消息绑定到 mailbox；一个 thread 不能复用到另一个 session。
- Ctrl+C / SIGTERM：停止接收请求，等待关闭和在途处理，结束本连接器拥有的 Codex 进程，然后释放状态锁。
- daemon 崩溃时，`running` 工作在重启后标为 `uncertain`，**不会自动重跑**；失败/不确定工作会暂停后续队列。先检查 Codex、项目文件和 Slack，确认已发生的行为，再由操作者执行 `resolve --session ID --job JOB_ID`。这只解除暂停，不重播旧请求。
- 崩溃可能留下 `daemon.lock`。**先确认没有该 connector / 它的 Codex 子进程仍在运行**，再删除该配置目录中的锁文件并重启。不要运行多个 daemon 共享一个配置目录，不要盲目删锁。
- 磁盘写入失败后 daemon 拒绝继续持久化；修复存储并安全重启，不会在未落盘时确认消息。
- 不保证端到端 exactly-once。Slack 网络故障、发帖成功后崩溃、创建 thread 后保存失败都可能留下不确定/重复消息。失败不要盲目重试；先检查 Slack。状态和已收到的 inbox 会持久化；daemon 离线期间 Slack 事件不保证补发，本版本不做历史消息回填。
- 修改 allowlist 后重启生效；已撤销频道的队列不执行，不能再向其发送。移除项目别名会阻止旧映射执行；**不要把已有别名改指向另一个项目**。

## 开发与测试

```sh
npm ci
npm run typecheck
npm test
```

测试使用 fake Slack/fake Codex app-server，覆盖路由、白名单、重复事件、FIFO、mailbox、状态恢复、文件失败回滚、HTTP 鉴权、协议事件、审批拒绝、子进程关闭和跨平台 launcher 参数。它们不调用真实 Codex、不访问真实 Slack、不需要 secret，也不会生成 CI run。

更多：[`docs/SECURITY.md`](docs/SECURITY.md)、[`docs/PROTOCOL.md`](docs/PROTOCOL.md)。
