# 显式远程屏幕截图

桌面版可以列出显示器，并把一次请求的全部屏幕或某个屏幕作为 JPEG 文件发送到**该请求的 Slack 线程**。不运行 Codex、不启动模型任务、不订阅屏幕、不后台定时截图。

## 本机启用一次

1. 停止 Connector。在设置里开启「允许显式远程屏幕截图」，阅读并确认风险提示，保存后启动连接。
2. Slack App 增加 bot scope `files:write` 并重新安装到工作区；已有的 `chat:write`、频道历史和身份权限仍需保留。仓库的 App manifest 已包含该 scope。代码不会自行扩大 OAuth 权限。
3. macOS 需要授予 **Codex Connector 的 Screen Recording / 屏幕录制** 权限。第一次明确截图请求可触发系统权限流程；拒绝时到系统设置 → 隐私与安全性 → 屏幕录制处理，然后完全退出并重新打开桌面应用。开发模式可能由终端或 Electron 承担权限身份。

默认和旧配置均关闭：`"screenPolicy": {"enabled": false}`。只能本机设置启用，Slack 指令不能修改。启用后，配置中允许的 Slack 人类用户和精确匹配身份的可信 bot 可以明确请求截图，不再逐次弹出应用确认。原有指令频道限制依然生效。

**画面不会自动识别或遮挡秘密。** 截图可能包含密码、个人信息、其他应用或其他人的内容。发送前请关闭/隐藏敏感窗口，确保请求者和频道内成员有权查看。没有“无秘密”保证。所选屏幕以外的缩略图可能被 Electron 暂时取得到内存，但不会编码发送；枚举显示器本身不获取画面。

## 指令

仍使用严格协议 envelope、正确的 connector target 和每次唯一 id。下面的 JSON 是 command/params 部分，不是完整消息。

- 列出屏幕：`"command":"screen.list","params":{}`。返回显示器 ID、逻辑尺寸、缩放比例、主屏标记、系统权限和选择支持状态；不返回窗口标题或截图。
- 一次全部：`"command":"screen.capture","params":{"displayId":"all"}`。
- 选择屏幕：`"command":"screen.capture","params":{"displayId":"屏幕列表中的精确ID"}`。

`displayId` 必填；不会选择“最新”或默认为主屏。ID 不是固定的屏幕序号，热插拔后请重新列出。选择不存在、映射不唯一、画面为空或捕获途中显示器变化都会失败，不会偷偷换成另一块屏幕或将部分结果称作全部。

示例完整请求：

```text
CODEX_CONNECTOR_COMMAND_BEGIN
{"v":1,"id":"screen-capture-0001","target":"YOUR_CONNECTOR_ID","command":"screen.capture","params":{"displayId":"all"}}
CODEX_CONNECTOR_COMMAND_END
```

图片使用 Slack 当前 external-upload 流程，固定上传到已经验证可访问的**指令来源频道/线程**，没有任意收件人参数。CLI 可以查询屏幕元数据（由桌面拥有的服务提供），但本地无 Slack 来源的 `screen.capture` 会被拒绝；纯 CLI/headless 服务报告 `SCREEN_DESKTOP_REQUIRED`。

## 限制、失败和留存

- macOS 和 Windows 的交互桌面、Linux X11：实现基于 Electron `desktopCapturer` 和精确 `display_id` 映射；还需真实平台验收。本次只进行了模拟接口/集成测试，没有真实 OS 截图或真实 Slack 上传验收。
- Linux Wayland/PipeWire：不支持可靠的全部/指定物理显示器映射，返回 `SCREEN_SELECTION_UNAVAILABLE`。不把 portal 返回的单一来源冒充全部屏幕；不会绕过 portal 或自动改用另一会话。只有 native display ID 可唯一映射时 X11 才成功。
- 必须存在已登录的可用图形桌面。锁屏时拒绝；预登录服务、远程桌面、安全桌面、DRM/受保护画面可能不可用、黑屏或缺失。不能保证检测所有 OS 锁定/黑屏情况，也不会绕过限制。
- 最多 8 块显示器。每张 JPEG 长边不超过 2560 像素、质量 85、最多 5 MiB，总计最多 20 MiB。Retina/HiDPI 缩略图会按比例缩小；不是原生无损截图。
- 原始图片不写临时文件、日志、状态、结果分页或重试队列，仅短暂保存在进程内存。上传后 Slack 文件及其保留/访问规则仍适用；内存分配器或系统交换空间不保证密码学擦除。
- 请求开始执行时若超过 60 秒则过期；重启不会执行旧的排队截图。已执行请求 ID 重放不重新捕获。无后台截图、自动重试或缓存画面复用。
- 原生捕获超过 15 秒返回 `SCREEN_TIMEOUT`，后续返回 `SCREEN_RESTART_REQUIRED`。请**完全退出并重新打开桌面应用**，仅停止/启动 Connector 不够。Electron 没有中止此原生调用的 API，因此丢弃迟到结果，不累积新的挂起捕获。
- Slack 网络请求有真实 10 秒请求超时且不自动重试。`SCREEN_UPLOAD_REJECTED` 表示已知拒绝，检查 `files:write`、成员身份或限流。`SCREEN_UPLOAD_UNCERTAIN` 表示可能已上传部分/全部，请先检查线程；不要为恢复旧结果重复截图。此状态不阻止以后有新目的的、使用新 ID 的明确截图请求。停机等待在途工作，不强杀进程。

技术参考：[Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)、[DesktopCapturerSource](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source)、[Slack Node SDK file uploads](https://docs.slack.dev/tools/node-slack-sdk/web-api/#upload-a-file)。
