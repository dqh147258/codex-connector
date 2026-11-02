# Codex Connector 桌面预览版

桌面界面包装现有连接器，不是新的一套会话协议。macOS 优先；Windows 打包目标已配置；Linux 登录项开关暂不支持并明确禁用。原 CLI 继续保留。

## 普通用户的流程

1. 使用适合 Apple Silicon（arm64）或 Intel（x64）的桌面应用。它包含 Electron/Node 及运行时依赖，**不需要安装 Node、不需要 npm ci、不需要编辑 JSON**。
2. 打开“设置向导”。点击“创建 Slack App”或“复制 App 清单”：在 Slack 的 Create New App → From a manifest 中粘贴清单。创建 xapp app-level token（connections:write）和 xoxb bot token；只在应用的密码框输入。
3. “验证 Slack”获取工作区身份。两个令牌各自有效不代表已证明来自同一个 App，请确认均在刚创建的同一个 App 页面取得。
4. 选择或填写你的用户 ID、dot 的用户 ID。查询 dot 会交叉核对 U/B/A 身份，避免把 connector 自己的 App ID 填给 dot。用户和频道列表可能分页，界面会说明尚有更多，可手动填写准确 ID。
5. 最小 manifest 不扩大权限。频道自动列表若缺少 channels:read/groups:read，会说明所需权限并提供手动频道 ID；应用不会自动追加授权。把 dot 和 connector bot 都邀请进测试频道，不用 DM。
6. 选择 Codex 程序和允许只读的项目目录，点击版本/能力检测。默认不锁定 Codex 版本号；检测结果不是所有版本都兼容的承诺。
7. 保存并启动。界面分别显示“本地服务”和“共享 Codex”状态。前者就绪不代表共享会话可控；错误和下一步提示不会显示原始令牌或私密日志。
8. 先用可丢弃测试会话验收，再按需求管理真实会话。应用不自动批准操作，也不改变现有 Codex 沙箱。

## 令牌与旧配置

- 令牌由主进程使用 Electron safeStorage 加密保存。macOS 使用 Keychain，Windows 使用系统用户加密。Linux 没有安全存储或选择 basic_text 时拒绝保存，不伪装安全加密。
- renderer 只知道是否已保存，不能读回令牌；输入提交后清空，不使用浏览器 localStorage/sessionStorage。原始 SDK 错误不展示。
- 导入配置只预览；用户明确保存才写入应用自己的私有目录，不修改原 CLI 配置/令牌/会话状态。应用有独立状态空间；不会静默复制旧会话映射。
- 未签名应用升级时 Keychain 可能重新询问或无法识别旧密钥；重新输入两个令牌可显式替换损坏的密文。没有明文回退。

## 登录自启动与自动连接是两个开关

- **登录自启动**：macOS/Windows 的系统登录项，仅在打包应用中可操作；每次用户点击都会明确确认，并重新查询系统实际状态。系统拒绝/需审批时不会显示“已启用”。不是开机登录前服务。
- **打开后自动连接**：应用启动后是否尝试连接，默认关闭。它不等于允许自动启动共享 daemon；后者仍是单独的明确选项。
- **关闭窗口保留托盘**：默认开启；关闭窗口并不退出。点“退出应用”会先安全停止自己拥有的连接器进程，不关闭共享 Codex daemon。
- Linux 本版不实现系统登录项变更，界面明确显示不支持；不要因此改用 root 或复制其他平台的命令。

## 停止与遗留锁

重复点击停止或退出不会反复发送终止信号。桌面父子进程通过固定 IPC 请求安全清理；CLI 也改为幂等处理重复 Ctrl-C。不能确认已停止时保留进程所有权并报告，而不是强杀共享进程。

“恢复遗留锁”仅当锁是当前用户拥有的普通文件、PID 明确不存在且再次检查未变化时可执行，并需要确认；只改名备份锁，不删 state.json、api.token 或其他数据。Windows 无法可靠验证锁所有权时拒绝自动恢复。

## 打包与验证限制

开发者：`npm ci --ignore-scripts`、`node node_modules/electron/install.js`、`npm run desktop:dev`。构建使用 `npm run desktop:dist`；运行时依赖自动随包附带，开发依赖不交付。

Draft PR 的同仓限定路径触发两个标准 macOS runner（arm64/x64），只读权限、无用户秘密；构建 unsigned dmg/zip，验证内置 Node/CLI 能加载运行时依赖，产物保留 3 天。不会自动发布或合并。

**预览构建未签名、未公证，不代表已满足 macOS 分发安全要求。** 不提供关闭 Gatekeeper 或降低系统保护的步骤；正式便捷分发需所有者提供正常签名/公证配置。托盘、系统登录项、Keychain、真实 Slack、共享会话及睡眠唤醒仍需目标机器验收，不能由纯 mock 测试或打包成功代替。

依据：[Electron 安全检查清单](https://www.electronjs.org/docs/latest/tutorial/security/)、[safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)、[系统登录项 API](https://www.electronjs.org/docs/latest/api/app#appsetloginitemsettingssettings-macos-windows)、[内置 Node 模式](https://www.electronjs.org/docs/latest/api/environment-variables#electron_run_as_node)。

## Slack 传输兼容边界

原有命令仍要求完整消息内开始/结束标记独占行；不搜索引用、代码块或自然语言中的命令。普通旧消息可继续使用严格 `event.text`，Slack 自动生成的 rich_text 仅用于显示。若存在显式 section/plain_text 命令 block，则无论 fallback 是否已经有效，都必须验证完整结构和文本一致性；不能利用相互矛盾的两个命令来源。

仅在已经校验工作区、频道和完整 bot 身份的消息中，如果 `event.text` 因换行传输而不符合 envelope 格式，可使用**唯一一个** `section` / `plain_text` block 保留的原文。该 block 必须本身通过同一严格解析；仅允许可选 `block_id` 和布尔 `emoji`，不能有 accessory、fields 或其他 block。fallback text 必须逐字等于 block 原文，或逐字等于其将每个换行替换为一个空格的结果；不 trim、不合并任意空白、不解码 HTML、不猜测 JSON。block 上限 3,000 字符。人类审批及服务器查询到的人类审批证据不使用此兼容路径。

这一边界有合成事件回归测试。现场不同 Slack 读取接口曾显示不同的换行投影，尚未取得原始 Socket Mode 事件证明，因此不把此次增强描述成已确认的现场根因修复；安装新版后仍需只读 `capabilities` 验证。

依据：[Slack section block](https://docs.slack.dev/reference/block-kit/blocks/section-block/)、[plain_text 对象](https://docs.slack.dev/reference/block-kit/composition-objects/text-object/)。
