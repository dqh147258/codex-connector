# Protocol and verification notes

Research snapshot: 2026-11-01. This connector uses official app-server JSON messages, not TUI scraping or undocumented rollout files. App-server remains experimental and target CLI versions can differ; validate the locally installed version before production use.

## App-server subset

- Spawn the configured executable with `app-server` over stdin/stdout (newline-delimited JSON messages; no `jsonrpc` field).
- `initialize` with `clientInfo`, then `initialized`.
- `thread/start` captures **`result.thread.id`**. Do not substitute `thread.sessionId`, which can identify the root of a fork tree.
- Restart recovery resumes only an explicitly stored connector-owned thread ID with `thread/resume` and `excludeTurns: true`. No session directory inspection or “latest thread” lookup.
- `turn/start` supplies typed text input; no shell invocation. FIFO begins another turn only after a terminal result and successful durable bookkeeping.
- `item/completed` of type `agentMessage` is collected only for absent/final_answer phase. Reasoning, tool output, commentary and raw logs are not automatically shared.
- `turn/completed` resolves/rejects the matching active thread/turn. Failed turns pause the queue. There is no automatic replay on disconnect or timeout.
- Command/file approval requests receive `result: {decision: "decline"}`; other server-initiated interactive requests receive a protocol error and stop the affected turn. The owned app-server process is terminated on turn failure, preventing unconfirmed interruption from overlapping resumed work.
- Legacy read-only/workspace-write mode sets sandbox policy explicitly. Explicit inherit mode sends **neither** legacy sandbox field and never changes approval policy. It does not claim named-profile discovery/selection support.

## Skill route

The shipped `skills/codex-connector/SKILL.md` instructs Codex to execute local CLI commands. CLI requests POST JSON to an authenticated loopback API. APIs operate only on preconfigured projects/channels and stored handles. Existing interactive sessions use explicit mailbox read/ack rather than forced injection.

The integration suite executes the actual compiled CLI as a subprocess, crosses HTTP auth/JSON dispatch, creates a mapped fake Slack thread, sends UTF-8 text, reads an accepted fake Slack reply and acknowledges it. It proves the local route independent of real Codex. It **does not** prove that every Codex OS sandbox grants loopback access. No security policy is weakened to make the test pass.

## Verification performed

- TypeScript strict typecheck/build.
- Unit/integration tests with fake Slack and a pure Node mock of the app-server protocol.
- Default-deny allowlists, bot/edit suppression, duplicate events, crash-window recovery, per-session serialization, revocation, HTTP auth/origin/Host checks, mailbox semantics, paused recovery, lock safety, storage-error rollback, shutdown waiting, literal-text CLI transport and policy-override omission.
- Fake protocol: initialize/start/resume, final-only routing, inherited approval policy, approval/input fail-closed, subprocess failure/exit and secret environment stripping.
- Windows launcher argument construction and shell-shim refusal tested on Linux, **not** native Windows process-tree/sandbox execution.
- Independent review additionally exercised a real 30-second request timeout using a fake Node server (not Codex).

Not performed: real Slack OAuth/socket/post round trip; real Codex invocation/auth/model turn; real Windows/macOS end-to-end; effective user permission-profile/proxy verification. No CI was created or triggered.

## Official references

- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [Codex CLI reference](https://learn.chatgpt.com/docs/cli/reference)
- [Codex permissions](https://learn.chatgpt.com/docs/permissions)
- [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)
- [Slack Node SDK](https://docs.slack.dev/tools/node-slack-sdk/)
- [Slack chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/)
- [Slack rate limits](https://docs.slack.dev/apis/web-api/rate-limits/)

These are design references, not a claim of live end-to-end certification.
