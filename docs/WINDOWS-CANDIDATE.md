# Windows：单次、只读验证默认 owner 路由

本检查回答一个窄问题：**从拟运行 Connector 的普通用户环境，候选版能否通过指定官方 Codex 的默认 proxy 完成协议握手？** 它不读取会话列表、正文、文件或审批，不发 Slack，不启动 daemon，也不写 Connector 配置/状态。不能用握手通过代替“已接管某个桌面会话”。

## 前提

- 使用已核对来源/哈希的候选包，在未提升权限的 PowerShell 中进入包的根目录；使用 Node 22+。须有 `scripts/verify-default-owner.mjs`、已编译的 `dist/src`、包根 `package.json` 和运行依赖 `ws`。若包缺依赖或文件，停止并报告，不从不明来源下载替代文件。
- 操作者从其**已知的官方安装**选取目标 `codex.exe` 的本机绝对路径。脚本不会查找可执行文件、枚举进程、读取桌面客户端目录或尝试其它版本。仅文件名相符不证明签名、所有者或来源。
- 在与目标主人相同的 Windows 帐户/环境运行。脚本保留当前环境的 `CODEX_HOME` 选择，未设置时让 CLI 自选默认；不读取和输出其实际路径。不要为了获得绿色结果，临时改 Home、指定 socket、更换账户、提权、停止或重启现有 daemon。生产 Connector 是否确实运行在同一环境，须另行核对。
- 若需要测试 **正在运行的 owner**，应由操作者先确认它已存在；探测只使用 `--version`、`app-server proxy`（无 `--sock`）、WebSocket upgrade 和 `initialize` / `initialized`。不会请求启动、停止、修复或更新。

## 执行一次

```powershell
$CodexExe = 'C:\REPLACE_WITH_CONFIRMED_OFFICIAL_INSTALL\codex.exe'
node .\scripts\verify-default-owner.mjs --codex-exe "$CodexExe"
$LASTEXITCODE
```

从输出记录 `mode`、`cachedBefore`、`cachedAfter`、`probePassed`、`cleanup`、`ok` 和退出码。不要附上真实路径、用户名、环境变量、密钥或原始 stderr。除了脚本帮助，不需要从上一次的日志拼证据。

- `cachedBefore.health:"unknown"` 表示此诊断进程尚未探测，不是桌面客户端的缓存。`cachedAfter` 在主动断开前采样；`online` 表示初始协议握手完成。`lastFailure` 与 `lastFailureStage` 仅记录允许公开的分类（未知则 null 或通用失败）。不要把执行文件版本探测成功说成服务连接成功。
- `executableVersion` 仅来自指定文件的 `--version`；`serverVersion:null` 表示**未独立核实服务版本**。`homeVerified:false` 是因为此检查不指定/比对 Home，也不证明某个 Desktop 窗口使用了同一个 daemon。
- `ok:true`、退出码 0 代表这个模式的检查通过。`cleanup:"close-returned"` 只表示关闭自己这次 proxy 的过程已返回；没有执行 `daemon stop`、`taskkill`、按名称清进程或中断任何模型工作。退出码 1 为失败/关闭结果不确定，2 为参数或依赖问题；不要连续重试来掩盖它。
- 失败或原生 owner 不可达时，保留“不通过/未验证”。不要改配置、改权限、开启后台重试，也不要把备用 socket、独占 app-server、离线 fixture 或他人会话的成功当成这次成功。

## 可选：离线种子检查（不验证任何真实 owner）

若候选包包含仓库的 `test/fixtures/app-server.cjs`，可在完全不碰真实 Codex/Slack 的情况下检查 Node、`ws`、包结构和相同的握手代码：

```powershell
node .\scripts\verify-default-owner.mjs --offline-fixture
$LASTEXITCODE
```

该模式只使用固定的仓库 fixture，不接受自选脚本/路径；`mode` 明确标为 `offline-synthetic-fixture`。它成功也不能替代实机验证。包未附 fixture 时跳过该步，而不是让另一条命令接触真实会话。
