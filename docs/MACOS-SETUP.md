# macOS 配置与验收：Codex Connector 0.2 预发布版

适用源码：以对应预发布附件 `RELEASE-INFO.json` 的 `sourceCommit` 为准。这是待你实机验收的预发布实现，不代表真实 macOS、Slack 或共享会话审批回放已全部通过。下面的安装、App 授权和启动操作均由你在本机审查后执行；不要把任何 token 发给 dot。

## 1. 准备程序

需要 Node.js **22+**、npm，以及同一普通 macOS 账户下已安装、已登录的 Codex。先把发布包解压到固定私人目录，在该目录打开终端：

```sh
node --version
npm --version
```

- **源码包**：执行 `npm ci --ignore-scripts && npm run build`。
- **附带 dist 的 portable Node 包**：执行 `npm ci --omit=dev --ignore-scripts`，不需要重新编译；它不是自带 Node 的原生 macOS App。

**必须先完成上面的 npm ci 安装依赖，再运行 init。portable 包只附预编译 JavaScript，不含 node_modules，也不是免安装独立程序；否则会出现 ERR_MODULE_NOT_FOUND（例如 @slack/socket-mode）。**

然后：

```sh
node dist/src/cli.js init
```

这只生成 `~/.codex-connector/config.json` 和私有 `api.token`，不启动 Codex。已有 0.1 配置请先备份，改用新的配置目录，如每条 CLI 命令都加 `--home "$HOME/.codex-connector-v02"`，不要直接覆盖运行中的旧实例。

## 2. 创建 Slack App：准确入口与方法

打开 [Slack App 创建/管理页面](https://api.slack.com/apps)，登录目标工作区。点击 **Create New App → From a manifest**，选工作区，在 JSON 页签粘贴发布包内 `slack-app-manifest.json` 的完整内容，Next 后检查并 Create。[官方 manifest 流程](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)

导入后检查：

- **Socket Mode** 已开启；不需要公网服务器或 Request URL。
- **OAuth & Permissions → Bot Token Scopes** 只有当前清单需要的 `chat:write`、`channels:history`、`groups:history`、`users:read`。
- **Event Subscriptions → Subscribe to bot events** 是 `message.channels`、`message.groups`。

随后取得两种不同的 token：

1. **Basic Information → App-Level Tokens → Generate Token and Scopes**：自定名称，添加 **`connections:write`**，生成 `xapp-…`，作为 `SLACK_APP_TOKEN`。[Socket Mode 设置](https://docs.slack.dev/apis/events-api/using-socket-mode/) · [该 scope 的用途](https://docs.slack.dev/reference/scopes/connections.write/)
2. **OAuth & Permissions → Install to Workspace**（或左侧 Install App），检查授权并 Allow；复制 **Bot User OAuth Token `xoxb-…`**，作为 `SLACK_BOT_TOKEN`。如工作区要求管理员审批，先完成审批；以后改 scope 需重新安装授权。

选择一个用于测试的**频道**，将新建的 **Codex Connector bot 和 dot** 都加入；输入和输出可以先用同一个频道，分开时两边都加入。不要使用 Carl 与 dot 的 DM，也不要使用多人 DM：本版只订阅公开/私有频道消息，没有 DM 订阅。

## 3. 私密保存 token

在仓库终端执行：

```sh
umask 077
mkdir -p "$HOME/.codex-connector"
chmod 700 "$HOME/.codex-connector"
touch "$HOME/.codex-connector/service.env"
chmod 600 "$HOME/.codex-connector/service.env"
nano "$HOME/.codex-connector/service.env"
```

在编辑器内输入以下内容并把占位值替换成真实 token；不要把带真实 token 的 `export` 命令粘进终端历史：

```dotenv
SLACK_APP_TOKEN=xapp-替换为自己的令牌
SLACK_BOT_TOKEN=xoxb-替换为自己的令牌
```

这是 Node 环境文件，不写 `export`。不要存进 Git、共享云盘、截图或 Slack。CLI 的 `--home` 会选择配置目录；如果另外填写 `CONNECTOR_HOME`，必须填实际绝对路径，不能写未展开的 `$HOME`。已有进程环境中的同名变量优先于 env 文件，启动前应清除旧值。

## 4. 填写 config.json：不要混淆 connector 与 dot

打开 `~/.codex-connector/config.json`，以包内 `config.example.json` 的字段结构为准；JSON 不支持注释。

| 字段 | 填写内容 |
|---|---|
| `instanceId` | 例如 `carl-mac`，后续命令的 `target` 必须一致 |
| `slack.teamId` | 目标工作区真实 `T…` ID |
| `slack.inputChannel` / `outputChannel` | 刚选择的真实频道 `C…` 或 `G…` ID；不是频道名称/链接/DM ID |
| `slack.allowedHumans` / `approvalUsers` | Carl 的真实 `U…` ID，审批用户必须也在 allowedHumans 中 |
| `slack.dot.name` | dot 的实际显示名；不是新建的 Codex Connector 名称 |
| `slack.dot.userId` | dot 的稳定 `U…` ID，建议始终填写，避免重名 |
| `slack.trustedBots` | **dot** 的 `botId: B…`、`userId: U…`、`appId: A…`；三者都必须匹配，不是新建 connector 的 ID |
| `projects` | 项目别名到现存本机目录绝对路径，例如 `{"demo":"/Users/carl/work/demo"}` |
| `backend.executable` | 实际 Codex 原生程序或 npm 的 `bin/codex.js` 绝对路径 |
| `backend.expectedVersion` | 可选，默认不填，因此不限制版本号；只有主动填写才要求完全匹配。已有配置删除该字段并重启即可取消旧门槛，实际版本与接口错误仍会报告 |

### 找到频道与 dot 的 ID

频道可在 Slack 频道详情中查看/复制 ID，也可从该频道网页 URL 的 `/client/T…/C…` 段读取，务必核对是目标频道。用户 ID 在成员资料的 **More → Copy member ID**。[Slack 官方用户 ID 说明](https://slack.com/help/articles/360003827751-Create-a-link-to-a-members-profile)

下面从你复制的 dot 用户 ID 查询其 profile.bot_id，再通过 bots.info 交叉核对 appId 和 userId；不是从显示名猜测。以下仅在你本机读取 Slack 身份，不启动 Codex；先把 `U_REPLACE` 改为已验证的 **dot 用户 ID**：[官方 profile 字段](https://docs.slack.dev/reference/objects/user-object/)

```sh
node --env-file="$HOME/.codex-connector/service.env" --input-type=module <<'JS'
import { WebClient } from '@slack/web-api';
const web = new WebClient(process.env.SLACK_BOT_TOKEN);
try {
  const auth = await web.auth.test();
  const dotUserId = 'U_REPLACE';
  const info = await web.users.info({user: dotUserId});
  const botId = info.user?.profile?.bot_id;
  if (!botId || info.user?.deleted) throw new Error();
  const result = await web.bots.info({bot: botId});
  const b = result.bot;
  if (b?.id !== botId || b.user_id !== dotUserId || !b.app_id || b.deleted) throw new Error();
  console.log(JSON.stringify({teamId: auth.team_id, dotName: info.user?.profile?.display_name || info.user?.name,
    trustedBot: {botId:b.id,userId:b.user_id,appId:b.app_id}}, null, 2));
} catch { console.error('身份查询失败：检查 token、users:read、工作区及 dot 用户 ID；不要贴出 token。'); process.exitCode=1; }
JS
```

核对输出确实对应你要信任的 dot，再抄入配置。若 profile 没有 bot_id，先停止；可请 App 管理者核对 dot 的真实 message 事件中的 bot_id/app_id，不要猜 ID 或删掉白名单检查。`auth.test` 查的是新 connector 自身，不能把它的 user/bot ID 当 dot；上面只从它取工作区 ID。`bots.info` 使用清单已有 `users:read`，无需额外申请管理员权限。[官方 bot 字段与 scope](https://docs.slack.dev/reference/methods/bots.info/)

### Codex 路径与共享 daemon

在本机终端定位安装，不要盲填 Homebrew 示例路径：

```sh
command -v codex
node -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$(command -v codex)"
```

把解析后的真实路径填入 `backend.executable`；如果是 npm 安装，可能落到 `…/@openai/codex/bin/codex.js`。连接器对 `.js/.mjs/.cjs` 用当前 Node 启动；原生文件直接执行。这样也避免登录服务找不到交互 shell 的 PATH。若 `command -v` 返回 alias/function 或找不到程序，先解决本机安装路径，不要填写猜测地址。

默认保留：

```json
"sessionPolicy": { "allowAllSharedSessions": false },
"backend": {
  "executable": "/替换为真实绝对路径/codex",
  "autoStartDaemon": false
}
```

**默认共享 daemon 要已在同一普通账户下可用。** 如果你明确希望 connector 冷启动时帮忙启动它，可在本机把 `autoStartDaemon` 改成 `true`：版本探测后（仅主动填写 expectedVersion 时额外检查匹配）会调用一次官方 `app-server daemon start`，超时 15 秒，不会主动 stop/update 或提权；但官方启动本身可能准备 daemon 包、管理已有 updater，受你现有 Codex 设置影响。不能同时指定 `socketPath`；通常省略 socketPath，让 Codex 选默认共享 socket。

`projects` 同时限定默认可控会话位置与只读文件根。只有你明确要管理项目根以外的同账户共享会话时，才在本机启用 `allowAllSharedSessions:true`；它**不扩大 files.* 的只读根、不取消原会话沙箱**。不要把整个 home 配成项目根来规避限制。

## 5. 先以前台方式验收

```sh
node dist/src/cli.js doctor
node --env-file="$HOME/.codex-connector/service.env" dist/src/cli.js start
```

`doctor` 仅检查本地配置、token 文件和可执行路径存在性，**不验证 Slack token、Codex 版本或共享 daemon**。`start` 才连接 Slack、检查 Codex 版本并连接共享 proxy；保持窗口开启，停止用 Ctrl-C。另开终端进入同一程序目录：

```sh
node dist/src/cli.js status
node dist/src/cli.js envelope --name help --params '{}'
node dist/src/cli.js envelope --name capabilities --params '{}'
node dist/src/cli.js envelope --name session.list --params '{"limit":20}'
```

将每次 `envelope` 的三行输出作为一条消息发到**输入频道**；前后不加解释、代码围栏、@ 或任何其他字符。Carl 的白名单账号可先测，再让 dot 用同格式测；每次新动作使用新 ID。确认返回的 `connected`、失败原因、会话分页和可管理限制，不能只看到 “online” 就认定接管成功。

验收顺序：help → capabilities → list → **明确挑选一个测试会话 attach** → 输出新 thread 正确 @dot → 再做该测试会话的发送/中断/人工审批。不要批量绑定生产会话。`session.list` 默认列出共享可见会话，不等于所有条目可管理；独立 `--no-daemon` 等例外不会被静默接管。

### 人工审批必须这样做

优先由 Carl **亲自回复该会话输出 thread**，完整使用 connector 给出的决定模板及 requestId/epoch/sessionId/turnId；不要只写“同意”，也不要在 DM 同意后让 dot 自称获准。

另一条路径是 dot 携带 `humanMessageTs` 转交同 thread 的完整人类决定，connector 独立回读核验。当前 Slack [conversations.replies 文档](https://docs.slack.dev/reference/methods/conversations.replies/) 列出 bot token 的 `channels:history/groups:history`，但不能据此宣称你的工作区实测已通过；实际频道成员关系、授权、消息可见性或接口错误仍可能阻止回读。遇到 `NEED_VERIFIABLE_HUMAN_DECISION`，请 Carl 直接回原 thread；不要追加用户 token 或放宽审批白名单绕过。

## 6. 前台通过后，再考虑登录自启动

先 Ctrl-C 停止前台实例。以下只**生成** LaunchAgent 文本，尚未安装/启动：

```sh
NODE="$(node -p 'process.execPath')"
REPO="$(pwd -P)"
HOME_DIR="$HOME/.codex-connector"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-connector-setup.XXXXXX")"
"$NODE" "$REPO/dist/src/cli.js" service-template \
  --platform macos --mode login \
  --node "$NODE" --script "$REPO/dist/src/cli.js" \
  --cwd "$REPO" --home "$HOME_DIR" > "$WORK_DIR/template.json"
"$NODE" -e 'const fs=require("node:fs"); const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2],t.content,{flag:"wx",mode:0o600});' \
  "$WORK_DIR/template.json" "$WORK_DIR/local.codex-connector.plist"
plutil -lint "$WORK_DIR/local.codex-connector.plist"
```

检查 JSON 的 `warnings/installInstructions` 和 plist 路径。它从相同的 `service.env` 读取 token；**JSON 整个文件不是 plist**。确认固定安装目录和 Node 路径不会变化、没有同配置的前台实例后，才由你手动选择安装：

```sh
mkdir -p "$HOME/Library/LaunchAgents"
# 若目标文件/label 已存在，先审查旧配置，不要盲目覆盖或重复加载。
install -m 600 "$WORK_DIR/local.codex-connector.plist" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
launchctl print "gui/$(id -u)/local.codex-connector"
node dist/src/cli.js status
```

这是**登录后启动**，不是开机登录前启动；FileVault、钥匙串、网络与 Codex 认证仍需本机验证。不需要 sudo，不要改成 root/LaunchDaemon。等当前工作安全停止后，可卸载登录项：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
rm -- "$HOME/Library/LaunchAgents/local.codex-connector.plist"
```

保留私密配置与会话状态；不要删 Codex 会话、共享 daemon 或改权限来绕过错误。更详细的跨平台与恢复说明见包内 `docs/STARTUP.md`、`README.md`。
