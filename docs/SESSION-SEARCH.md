# Slack 不提供原生对话文本搜索

无论仅启用 Slack 或与本机 API 并存，产品都不会在 Slack 搜索或返回原生用户输入、模型正文、匹配摘录、命中统计、旧快照或续页。收到 `NATIVE_CONTENT_LOCAL_ONLY` 表示该通道不提供功能，不是零命中。旧版 `session.search` 实验/兼容实现不是当前支持的产品工作流；不要通过 `result.page`、`result.next`、文件读取或附着会话绕过。

如果记得的是任务关键词，到原 Codex 界面核对；如果只需查看有界候选和活动时间，在 Slack 用 `session.list` / [`session.recent`](SESSION-RECENT.md)。开启本机入口且具备适当授权时，可使用[本机 Agent 接入](LOCAL-AGENTS.md)对已绑定的明确会话读取有界历史。元数据与更新时间不能证明任务内容或执行状态。
