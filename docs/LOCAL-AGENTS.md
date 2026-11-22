# 本机 Agent 接入：不需要 Slack

同一台电脑上，只启动一个 Connector daemon。本机 CLI、stdio MCP 和 Skill 通过受保护的环回 API 使用它；它们不会另起一台 Codex server。本机结果默认不会自动流向 Slack，普通 Slack 订阅和续页也不会转发原生正文。仅当本机操作者明确授权一个已核实的订阅与 Slack 线程时，才会按[内容分享规则](SLACK-OUTPUT.md)转发激活边界之后的合规内容。所有原生审批/输入仍只由原 Codex 界面处理。连接器只连接操作者预先配置的原生共享 daemon，不扫描所有进程或用户目录。这里给出源码安装方式，示例路径和 ID 都需要替换。

## 1. 先启动本机模式

需要 Node 22+，并已在目标普通用户账户下安装可用的原生 Codex 可执行文件。

```sh
npm ci
npm run build
node dist/src/cli.js init --mode local
```

这只创建私有配置模板和操作者凭证，不启动服务，也不覆盖已有文件。配置默认在 `~/.codex-connector`；所有操作者命令可用 `--home PATH` 指定别处。在生成的配置中把 `projects.demo` 和 `backend.executable` 换成实际**绝对路径**。保留 `local.enabled:true` 和 `slack.enabled:false`。同一账户下的目标原生共享 daemon 应已可用；默认不自动启动、不切换目标。运行：

```sh
node dist/src/cli.js doctor
node dist/src/cli.js start
# 另开终端
node dist/src/cli.js servers
node dist/src/cli.js status --server default
```

`servers` 只读缓存，不探测新进程。它显示已配置且对当前调用者可见的 server（包括离线或状态未知的条目）；连接器进程在线不代表目标 Codex 可用。`status` / `recover` 仅供操作者。新建目录时，`init --mode slack` 生成仅 Slack 的模板（`local.enabled:false`，不生成操作者 token）；配好 Slack 后，**不监听本机 API**。`init --mode dual` 生成同时启用两者的模板；本机不需要 Slack 的令牌才能独立工作。已有 v2 配置默认保留本机操作者与 Slack 路径；原有 `backend` 的 ID 为 `default`。

现有安装升级先做[只读迁移预检](CONNECTOR-MIGRATION.md)；Windows 的实际默认 owner 握手另见[单次验证说明](WINDOWS-CANDIDATE.md)。

## 2. 可选：注册多个原生 server

用下面的片段**替换**单个 `backend`，不要拿它覆盖整个配置：

```json
{
  "backends": {
    "main": {"executable":"/opt/codex/bin/codex","codexHome":"/home/alice/.codex"},
    "studio": {"executable":"/opt/codex/bin/codex","codexHome":"/home/alice/.codex-studio","aliases":["work"]}
  },
  "defaultServerId": "main"
}
```

多目标时，每个目标都必须对应一个不同且可验证的 Codex Home。配置绝对 `socketPath` 的目标必须同时填写 `codexHome`；不同 socket 路径可能转发到同一个 daemon，不能靠路径区分。未配置 `socketPath` 的默认连接仍使用官方代理自己选路；其预期 Home 是显式 `codexHome`，否则是启动环境继承的 `CODEX_HOME` 或当前账户默认 `~/.codex`。在发送任何会话请求之前，连接器会核对 daemon 握手的真实 Home；缺失或不匹配时该目标保持离线，不切换到其它目标。旧版单目标未固定 Home 时仍可使用官方代理；只有实际握手核对成功才会显示 `homeVerified:true`，没有证据时不算已核实。列表不暴露 Home、socket 或启动路径。Slack 启用时可用 `slack.servers` 限定其可见的规范 ID；代理授权列表同样使用规范 ID，而非别名。客户端可传别名，保留回执返回的**规范 serverId**用于后续请求。显式选择失败不是切换其它服务的授权。不要用同一个持久 server ID 指向另一台后端；如状态标记为 blocked，应由操作者核对配置，不能直接丢弃状态/锁重试。

配置没有固定的 Home 数量上限。连接按最多 4 个同时启动的代理分批进行，各自保留独立握手超时；一个目标离线或遇到 `BACKEND_RESOURCE_EXHAUSTED` 时，其他已连接目标仍可工作，连接器不会自动改用其他目标。

区分两个名字：命令 envelope 的 `target` 是 Connector 的 `instanceId`，`params.serverId` 才选择后端。CLI 的 `--server` 对应后者。无默认值且有多个候选时须显式选择。即使两个后端的原生 threadId 相同，也不是同一会话。

## 3. 给 Agent 独立的最小权限

不要把操作者的 `api.token`、配置目录或 Slack 凭据交给 Agent。每个 Agent 用独立的随机凭证；daemon 配置只保存该凭证原文的 SHA-256 小写十六进制摘要。以下代码由**操作者**在 Agent 的专用私密目录中运行一次：它只把摘要写到终端，明文写入新建的 `connector-agent.env`，若已存在则拒绝覆盖。请事先检查目录没有共享；Windows 请用 ACL 限制文件访问，Unix mode 不能替代 ACL。不运行此步骤也可以使用现有受管密钥。

```sh
node -e "const c=require('node:crypto'),f=require('node:fs'),t=c.randomBytes(32).toString('hex'); f.writeFileSync('connector-agent.env','CONNECTOR_TOKEN='+t,{mode:384,flag:'wx'}); console.log(c.createHash('sha256').update(t,'utf8').digest('hex'))"
```

将摘要填入配置（以下使用单 server 的 `default`；多 server 改成授权的规范 ID），然后重启 Connector 让新配置生效。按需要删减授权；不需要创建会话时删掉 `session.create`，不需要发消息时删掉 `session.send`。

```json
{
  "local": {
    "enabled": true,
    "agents": [{
      "id": "studio-assistant",
      "tokenHash": "替换成上一步的64位小写十六进制摘要",
      "servers": ["default"],
      "projects": ["demo"],
      "commands": ["server.list","session.list","session.attach","session.create","session.info","session.history","session.send","session.delivery","session.events"]
    }]
  }
}
```

这里**没有**授予 steer/interrupt、服务管理、审批、文件读取或 Slack 发布。Agent 继承的环境中只放它自己的 `CONNECTOR_TOKEN`；不要让 daemon 继承 Agent 的 token，不要在聊天、命令行参数、仓库或日志中放明文。已能读取操作者文件的进程不受应用层 token 范围保护：应在 OS 层分离。撤销 Agent 时移除其配置并重启；不要把同一 Agent ID 或 token 再分配给他人。

## 4. CLI、MCP 和 Skill

**CLI**：同一主机通过固定 `127.0.0.1` 访问，无自定义 URL，无环境代理。Agent 不需读取操作者 home；指定端口和实例（示例）：

```sh
node --env-file=/private/connector-agent.env /abs/connector/dist/src/cli.js servers --port 17381 --target my-computer
```

后续同样传这两个参数。没有显式 endpoint 时使用配置中的端口/实例；操作者 CLI 没有环境 token 才读取其私有 `api.token`。

**stdio MCP**：让支持 MCP stdio 的宿主以子进程启动这个命令，而不是连接一个公网地址。使用宿主已有的受管环境传递该 Agent 的 token，或使用下列 Node 私有环境文件形式（不要同时继承另一个 `CONNECTOR_TOKEN`）。示例是常见的 `mcpServers` 形式；有些宿主把同样的 `command` 和 `args` 放在 TOML 或界面中。

```json
{
  "mcpServers": {
    "codex-connector": {
      "command": "/absolute/path/to/node",
      "args": ["--env-file=/private/connector-agent.env","/absolute/connector/dist/src/cli.js","mcp","--port","17381","--target","my-computer"]
    }
  }
}
```

stdio 使用一行一条 JSON-RPC：`initialize` → `notifications/initialized` → `tools/list` / `tools/call`。stdout 无诊断文字。MCP 在缺少显式 token 时停止，不降级到操作者凭证。工具列表是支持的协议，不等于当前凭证获准全部工具。MCP 不提供原始 HTTP/RPC、shell、审批响应、Slack 定位参数或管理凭证的工具。

| 意图 | CLI | MCP |
|---|---|---|
| 可见 server | `servers` | `server_list` |
| 列出、绑定或新建 | `command --name session.list/attach/create`（选一个命令） | `session_list`、`session_attach`、`session_create` |
| 已绑定会话的信息、历史 | `command --name session.info/history` | `session_info`、`session_history` |
| 发消息/排队 | `command --name session.send/queue` | `session_send`、`session_queue` |
| 已授权的精确 turn 控制 | `command --name session.steer/interrupt` | `session_steer`、`session_interrupt` |
| 指定命令的回执 | `receipt --server ID --work-id WORK_ID` | `receipt_get` |
| 精确的消息处理证据 | `command --name session.delivery` | `session_delivery` |
| 停止本机订阅（不打断模型） | `unwatch --server ID --session-id SESSION_ID --subscription-id SUBSCRIPTION_ID` | `session_unwatch` |
| 订阅/轮询本机最终事件 | `events --session-id SESSION_ID --server ID` | `session_events` |

**Skill**：复制仓库 [skills/codex-connector](../skills/codex-connector/SKILL.md) 到允许加载的 Skill 目录。Skill 是操作说明，不授予权限；可使用上面的 MCP 或 CLI，二者都走同一个受认证 API。

## 5. 从创建到收到回复

以下为**操作者 CLI** 示例；Agent 使用上面的独立 token、端口和实例参数，权限检查仍在 daemon 中执行。

```sh
codex-connector command --server default --id create-demo-0001 --name session.create --params '{"project":"demo"}'
codex-connector receipt --server default --work-id WORK_ID
codex-connector events --server default --session-id SESSION_ID --wait-ms 0
codex-connector command --server default --id send-demo-0001 --name session.send --params-file send.json
codex-connector receipt --server default --work-id SEND_WORK_ID
codex-connector events --server default --session-id SESSION_ID --cursor RETURNED_CURSOR --wait-ms 20000
```

替换所有占位符。`send.json` 例如 `{"sessionId":"绑定回执中的实际ID","text":"说明现有测试，不修改文件。"}`。每个写操作使用新的稳定请求 ID；MCP 写工具必填 `requestId`。CLI 采用 `{ok,result}` 包装；MCP 工具的文本内容是同一 `result` 对应的 JSON。

- 第一条命令的返回只是**已接纳**。用该次返回的规范 serverId、work ID 和原身份读 receipt。若排队/执行中，稍后只读查询同一回执。创建完成时从 `result.sessionId` 取绑定句柄。已有会话用 `session.attach` 和明确的原生 threadId，不能把两种 ID 或不同 server 的回执混用。
- 在发送前先轮询一次：只有当前主体在此 server 上成功绑定的会话才能观察。把返回的游标与主体、server、会话一起保存。每次处理完事件才保存 `nextCursor`；同一事件 ID 去重，`hasMore` 时先读下一页。等待 0–30000 ms，单页 1–100 条；空页只是这次没读到，不代表已结束。关闭 MCP 或停止轮询不停止模型，也不注销已有订阅。无需再记录时，用本次返回的 subscriptionId 调用 unwatch；它只关闭自己的流，再次显式调用 events 才重新订阅。
- `assistant.final` 给出可见最终消息，`turn.completed` 给出该 turn 的终态，`local.action_required` 只提示在原生界面处理。不能从别人的消息、最新 turn 或类似文本推断自己的发送完成；核对 workId、turnId 及 `session.delivery`。仅本机独占绑定时可能看到原生客户端产生的事件，其 workId 为 null。事件不会输出工具日志、私密推理或审批细节；过长/敏感文本有截断或 withheld 标记。
- 若 `gap` 非空，断线、保留窗口或归属判断留下了观察缺口。使用精确的 history/delivery 仅对可核实部分补查，不能承诺离线期间完整回放。命令状态 `completed` 不等于模型完成；`uncertain` 或启动错误不等于消息未送达。保留原请求 ID 和原始参数核对，绝不换 ID 重发。
- `LOCAL_SCOPE_DENIED`：检查该身份的授权，不切换操作者 token。`SERVER_SELECTION_REQUIRED`：从可见列表明确选择。`LOCAL_BINDING_REQUIRED`：确认同一身份在该 server 成功绑定了该会话。原生批准/输入请求只在原 Codex 界面处理，Agent 不可自行回答。若沙箱禁止环回，报告限制，不向公网暴露 API，也不关掉沙箱。


A cancelled local subscription frees its active slot immediately. It retains no cursor key or event bodies. Resume that stream deliberately without the old cursor; a stale cursor cannot open a replacement stream. A `session.create` receipt marked `uncertain` means the native session might exist even though the connector could not verify its creation or bind it safely. Inspect the intended native server before acting; repeating the same request ID returns the existing receipt and a new ID does not bypass the recovery hold.
