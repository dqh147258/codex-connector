# Cold-start option added in0.2

`backend.autoStartDaemon` defaults to false. The local operator may set it to true to run fixed `codex app-server daemon start` once after version probing (and matching only when optional expectedVersion is explicitly configured), before connecting the shared proxy. Timeout 15 seconds; no retry storm, stop/update call or elevation. Do not combine it with explicit `socketPath`. Official Codex start can provision its daemon package/manage its updater according to the existing Codex settings; this connector does not alter update policy. On failure capabilities reports the outcome and the server stays available for help/status. Actual startup on each OS still needs validation.

Without this option, the shared daemon must already be available under the same nonprivileged account. Connector autostart alone is not full cold-boot readiness.

# 本地启动与自启动模板

本页中的命令是**供你在自己的电脑上检查后手动执行的操作说明**。项目开发/测试没有安装、启用或启动系统服务，也没有写入真实凭证。

`service-template` 只向 stdout 输出 JSON，其中 `content` 是服务文件文本。它不会自动安装文件、启用任务、启动 connector 或启动 Codex。服务管理不是 Slack 远程命令。

## 先理解启动边界

| 平台 / 模式 | 生成内容 | 实际边界 |
|---|---|---|
| Linux `login` | systemd user unit | 依赖该用户的 user manager；通常登录后可用。已有 lingering 配置会改变这个边界，连接器不会自动开启 lingering。 |
| Linux `prelogin` | systemd system unit，显式非 root `User` | 安装/启用通常需要管理员；程序仍以指定普通用户运行。 |
| macOS `login` | LaunchAgent | 用户登录 GUI 会话后启动。 |
| macOS `prelogin` | LaunchDaemon，显式非 root `UserName` | 由系统 launchd 启动，但 FileVault、用户钥匙串和登录前主目录可用性仍可能限制运行。 |
| Windows `login` | LogonTrigger + InteractiveToken task | 仅在指定用户登录后运行；不等于开机登录前可用。 |
| Windows `prelogin` | BootTrigger + S4U task | 不保存账户密码，但 S4U 对网络资源/EFS 有限制；不能保证登录前 Slack/Codex 可用。需要本机验证，失败时优先选择 login。 |

**默认情况下，本版本仅连接共享 Codex daemon，不自动启动它。** 未启用本机 `backend.autoStartDaemon` 时，自启动的是 connector server；目标共享 daemon 必须已通过独立、经你批准的方式，在**同一个非特权 OS 账户**下可用。启用该选项后会尝试上述固定启动命令，但仍须验证各平台的实际冷启动条件。`backend.executable`、版本、socket 及 Codex 的认证/权限配置也必须正确。

缺少共享 daemon 时，connector 不会偷偷改用独占 app-server，也不会为了连接而开启 root/SYSTEM 权限。查看 `status` 中的 backend/capability 结果；服务启动本身不证明会话可管理。若需要登录前工作，必须另外评估 Codex daemon、用户 runtime/socket 目录、加密主目录、网络及认证在登录前是否可用。

## 共同准备：路径、配置与私密环境文件

1. 使用 Node.js 22+；先执行仓库中的 `npm ci`、`npm run build`。
2. 完成本地 `init`、`config.json` 和 Slack 身份白名单配置。检查 `doctor`；它只做本地检查，不启动 Codex。
3. 固定安装路径。服务需要 Node 原生可执行文件、`dist/src/cli.js`、工作目录、配置目录的**绝对路径**。不要使用 `.cmd` / `.bat` shell shim，也不要把代码/配置放在别人可写的共享目录。
4. 在配置目录中**手动**创建 `service.env`。不要提交到 Git、发到 Slack 或复制进日志。

POSIX 示例（路径替换为你的实际配置目录）：

```dotenv
CONNECTOR_HOME=/home/alice/.codex-connector
SLACK_APP_TOKEN=xapp-REPLACE_WITH_YOUR_LOCAL_SECRET
SLACK_BOT_TOKEN=xoxb-REPLACE_WITH_YOUR_LOCAL_SECRET
```

Windows 示例使用正斜杠可避免环境文件中的反斜杠歧义：

```dotenv
CONNECTOR_HOME=C:/Users/alice/.codex-connector
SLACK_APP_TOKEN=xapp-REPLACE_WITH_YOUR_LOCAL_SECRET
SLACK_BOT_TOKEN=xoxb-REPLACE_WITH_YOUR_LOCAL_SECRET
```

`service.env` 不是 shell 脚本，不写 `export` 或 PowerShell 语句。模板使用 Node 的 `--env-file=绝对路径` 读取它，并显式传 `start --home 配置目录`；不通过 shell 执行。文件缺失时 Node 会启动失败，这比带着错误/空凭证继续运行更安全。

- Linux/macOS：配置目录及环境文件归目标普通用户所有，目录建议 `0700`，环境文件/token 建议 `0600`。可在确认路径后手动执行 `chmod 700 "$HOME/.codex-connector"`、`chmod 600 "$HOME/.codex-connector/service.env"`。不要为解决权限错误把秘密文件改成全员可读。
- Windows：在目录/文件的“属性 → 安全 → 高级”检查 ACL，只保留目标账户及必要的系统/管理员访问；Unix mode bits 不代表 Windows ACL。不要在文档、脚本、任务 XML 中保存账户密码。
- 程序会继承 OS 服务环境；启动前检查是否存在冲突的 `SLACK_*` / `CONNECTOR_HOME`。不要依赖交互 shell 的临时 PATH、shell profile 或临时环境变量。

以下示例均使用默认服务名称 `codex-connector`。CLI 当前不提供自定义 `--name` 选项。

## Linux

替换 `alice`、仓库路径和 Node 路径。先生成 JSON，再单独取出其中的服务文本；**不要把整个 JSON 当成 `.service` 文件**。

```sh
NODE="$(command -v node)"
REPO="/home/alice/codex-connector"
HOME_DIR="/home/alice/.codex-connector"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-connector-setup.XXXXXX")"

"$NODE" "$REPO/dist/src/cli.js" service-template \
  --platform linux --mode login \
  --node "$NODE" --script "$REPO/dist/src/cli.js" \
  --cwd "$REPO" --home "$HOME_DIR" \
  > "$WORK_DIR/template.json"

"$NODE" -e 'const fs=require("node:fs"); const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2],t.content,{flag:"wx",mode:0o600});' \
  "$WORK_DIR/template.json" "$WORK_DIR/codex-connector.service"
```

示例用 `mktemp -d` 创建私有暂存目录，避免在共享临时目录中覆盖别人的固定路径。提取命令使用 `flag: "wx"`，不会覆盖已有文件。若文件已存在，先审查/保留旧文件，再选一个新的输出路径。

需要 **prelogin** 时，只生成你选择的一种模式：把以上生成命令中的 `--mode login` 改为 `--mode prelogin --user alice`。这会生成 system unit，而不是 user unit；检查内容确实有 `User=alice`，不要改成 root。

### 手动安装 / 查看 / 移除

先阅读生成 JSON 中的 `warnings` 和 `installInstructions`，检查 `ExecStart`、`User`（如有）、配置路径与权限。以下是明确选择 login 后的手动操作：

```sh
mkdir -p "$HOME/.config/systemd/user"
install -m 600 "$WORK_DIR/codex-connector.service" "$HOME/.config/systemd/user/codex-connector.service"
systemctl --user daemon-reload
systemctl --user enable --now codex-connector.service
systemctl --user status codex-connector.service
```

移除 login 服务前先检查 connector 状态，等待进行中的工作进入安全停止点，然后：

```sh
systemctl --user disable --now codex-connector.service
rm -- "$HOME/.config/systemd/user/codex-connector.service"
systemctl --user daemon-reload
```

prelogin system unit 应由管理员审查后安装到 `/etc/systemd/system/codex-connector.service`（root 拥有 unit，运行账户仍是 `User=alice`），再使用系统级 `systemctl daemon-reload` / `enable --now`。移除时先系统级 `disable --now`，只删除该 unit，然后 reload。这些步骤需要管理员授权；连接器不会代为执行，也不会开启用户 lingering。

不要把运行 connector 的账户换成 root，也不要为了通过检查关闭 Codex 沙箱。Linux 模板有 `NoNewPrivileges=true`；若特定 Codex 安装在此约束下不可用，应检查安装/运行方式，而不是自动扩大权限。

## macOS

Apple Silicon Homebrew 的 Node 常见于 `/opt/homebrew/bin/node`，Intel 或其他安装位置可能不同。以下使用 `command -v node` 获取当前实际路径，但你仍应确认它是稳定可用的 Node 可执行文件。

```sh
NODE="$(command -v node)"
REPO="/Users/alice/codex-connector"
HOME_DIR="/Users/alice/.codex-connector"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-connector-setup.XXXXXX")"

"$NODE" "$REPO/dist/src/cli.js" service-template \
  --platform macos --mode login \
  --node "$NODE" --script "$REPO/dist/src/cli.js" \
  --cwd "$REPO" --home "$HOME_DIR" \
  > "$WORK_DIR/template.json"

"$NODE" -e 'const fs=require("node:fs"); const t=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); fs.writeFileSync(process.argv[2],t.content,{flag:"wx",mode:0o600});' \
  "$WORK_DIR/template.json" "$WORK_DIR/local.codex-connector.plist"

plutil -lint "$WORK_DIR/local.codex-connector.plist"
```

需要 **prelogin** 时，将生成命令改为 `--mode prelogin --user alice`。确认 plist 包含显式 `UserName=alice`。这不解锁 FileVault 主目录，不解锁用户钥匙串，也不会创建另一份 root Codex daemon。

### 手动安装 / 查看 / 移除

选择 login 后，经审查手动执行：

```sh
mkdir -p "$HOME/Library/LaunchAgents"
install -m 600 "$WORK_DIR/local.codex-connector.plist" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
launchctl print "gui/$(id -u)/local.codex-connector"
```

如果该 label 已加载，先检查现有配置，不要盲目重复 bootstrap。移除前先检查进行中的工作，再执行：

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/local.codex-connector.plist"
rm -- "$HOME/Library/LaunchAgents/local.codex-connector.plist"
```

prelogin plist 应由管理员审查后安装至 `/Library/LaunchDaemons/local.codex-connector.plist`，plist 的拥有者/权限遵循系统 launchd 要求；程序运行账户仍由非 root `UserName` 指定。管理员使用 `launchctl bootstrap system` 加载，使用 `launchctl bootout system` 卸载后再移除该文件。不要把 LaunchAgent 直接移到 LaunchDaemons 来规避登录限制。

## Windows（PowerShell，原生环境）

先检查 Node 与构建产物路径。以下生成 login task XML；`--user` 必填，使用与目标共享 Codex daemon 相同的实际账户。

```powershell
$Node = (Get-Command node.exe).Source
$Repo = 'C:\Users\alice\codex-connector'
$HomeDir = 'C:\Users\alice\.codex-connector'
$UserId = 'MYPC\alice' # 按实际账户替换，不要填写 SYSTEM / Administrator

$Template = & $Node "$Repo\dist\src\cli.js" service-template `
  --platform windows --mode login --user $UserId `
  --node $Node --script "$Repo\dist\src\cli.js" `
  --cwd $Repo --home $HomeDir | ConvertFrom-Json

$Template.warnings
$XmlPath = Join-Path $env:TEMP 'codex-connector.task.xml'
if (Test-Path $XmlPath) { throw '输出文件已存在，请先审查旧文件或选择新路径。' }
[System.IO.File]::WriteAllText($XmlPath, $Template.content, [System.Text.UTF8Encoding]::new($false))
```

需要 **prelogin** 时，仅将生成命令中的 `--mode login` 改为 `--mode prelogin`，保留同一个明确的非特权 `--user`。生成器使用 BootTrigger + S4U + LeastPrivilege，不保存或索取账户密码。

**S4U 不是 Windows 登录前网络可用性的保证。** 它需要相应的 batch-logon 权限，而且 Microsoft 文档说明其网络资源与 EFS 访问受到限制。用户主目录、现有 Codex socket/daemon、Slack HTTPS 和认证材料都要在该账户下实测。若不可用，优先使用 login 模式；不要把任务改成 SYSTEM、勾选最高权限或在脚本里保存密码来绕过。

### 手动安装 / 查看 / 移除

1. 打开“任务计划程序”，选择“导入任务”，导入审查后的 `$XmlPath`。
2. 核对运行账户、触发器和操作路径；保留 **LeastPrivilege / 不使用最高权限**。login 模式应是登录触发、仅指定用户登录时运行。
3. prelogin 的注册可能需要管理员及相应策略；若系统要求改变登录方式、保存密码或提升到 SYSTEM，暂停并重新评估，不要自动接受。
4. 先手动测试一次并检查 connector `status`，再安排实际登录/重启验证。服务模板导入成功不代表共享 Codex daemon 已就绪。
5. 移除时在任务计划程序中先“禁用”对应的 connector 任务，检查/等待当前工作进入安全停止点，再结束该任务并删除它。只删除自己的任务与导出的 XML，不删除 Codex daemon、会话或用户数据。

此处故意使用 UI 审查步骤，不提供包含账户密码的注册命令，也没有自动安装 Windows 服务。

## 检查与恢复

任何平台都应先验证前台运行，然后再选择自启动模式。由你在本机授权启动 connector 时，可使用服务同样的入口：

```text
node --env-file=/ABSOLUTE/CONFIG/service.env /ABSOLUTE/REPO/dist/src/cli.js start --home /ABSOLUTE/CONFIG
```

在另一个终端读取状态：

```text
node /ABSOLUTE/REPO/dist/src/cli.js status --home /ABSOLUTE/CONFIG
```

- 只存在一份使用同一配置/状态目录的 connector；不要同时运行前台实例和自启动实例。
- 停止 connector 不应停止共享 Codex daemon 或“接管”其他客户端的进程。重启后的未决请求/不确定状态应按主 README 的恢复流程处理，不盲目重放。
- 环境文件/token/状态文件保留在私人配置目录，不因移除自启动模板而自动删除。
- 本项目测试了模板生成、参数转义、身份与模式边界；**没有在真实 Windows/macOS/Linux 服务管理器中安装/启用这些模板，也没有做真实跨平台重启验证**。需要在你的目标机器上完成验证。

## 官方参考

- [systemd service](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html)、[systemd execution environment](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
- [Apple：创建 LaunchDaemons / LaunchAgents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [Microsoft：Task Scheduler schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema)、[任务的安全上下文](https://learn.microsoft.com/en-us/windows/win32/taskschd/security-contexts-for-running-tasks)
