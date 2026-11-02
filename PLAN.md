# Codex Connector server redesign plan

Status: implementation and local fake integration complete; published as Draft PR #1 (https://github.com/dqh147258/codex-connector/pull/1), awaiting live acceptance. No merge.

## Required outcome

A least-privilege Windows/Linux/macOS background server receives strict, authenticated Slack bot command envelopes; manages sessions on the user's **default shared Codex daemon** where supported; routes each session to one output thread mentioning a configured, resolved dot user ID; supplies readonly project-file tools; and relays correlated approvals/user-input without autoapproval or policy bypass.

## Phases and acceptance gates

1. **Protocol and capabilities** — Pin generated schema expectations to the installed/tested Codex version. Prefer `app-server proxy --sock` to the configured default daemon. Surface connection/version/permission failures explicitly; never silently replace it with an independent server while claiming default-session takeover. List/info/history/attach/create/send/queue/steer/interrupt use explicit allowlisted RPCs and `canAcceptDirectInput`/runtime status checks.
2. **Command and trust boundary** — Exact whole-message marker lines plus a versioned JSON envelope; validate command parameters, target instance and request ID. Authenticate workspace/channel/bot/user from Slack metadata, not JSON claims. Generate complete help from command schemas. Suppress output loops and duplicate/replayed envelopes.
3. **Durable dispatch and delivery** — Persist accepted commands before Slack acknowledgement. Separate command execution from an ordered durable output queue; a Slack-send failure must never rerun a Codex operation. Mark crash/disconnect ambiguity and pause rather than blindly replay. Isolate session mappings and reconnect epochs.
4. **Approvals and user input** — Relay exact server request details into the bound session thread. Correlate request ID, daemon epoch, session/thread and turn. Only directly authenticated authorized humans may decide; dot bots may relay tasks but cannot fabricate human approval. Deny on timeout; invalidate stale/duplicate/restarted requests. Never grant broader scope or accept-for-session automatically.
5. **Readonly tools and startup** — Project-root-only list/stat/read/literal-search with traversal/symlink/junction/device/secret guards and strict limits. Generate platform-native login/prelogin service definitions with explicit least-privilege identity; local-only management, no remote service commands or automatic privilege escalation. Do not install/enable a real service here.
6. **Verification and publication** — Fake Slack/shared-app-server integration, delimiter/replay/source-auth tests, filesystem escape tests, pending-request misuse and disconnection tests, durable outbox tests, three-OS service generation tests, strict build/typecheck, secret scan and independent review. Publish a refactor branch and draft PR, verify the remote commit. No merge and no newly configured CI.

## Runtime evidence / limits

Installed research CLI: `0.166.0-alpha.1`. Its generated schema uses thread sandbox `read-only` (not the old implementation's `readOnly`), exposes shared-session rejoin on `thread/resume`, `canAcceptDirectInput`, and queue APIs. Shared-daemon launch currently fails in this execution environment (`package link escapes its root`); isolated thread creation also fails a sandbox-helper directory check. These are unresolved runtime acceptance gates, not a reason to disable protections. Existing user sessions and existing private session storage are not accessed.

Real Slack credentials, paid model turns, real user-session mutation, native Windows/macOS end-to-end validation, and service activation remain outside this implementation run. Any unproven shared-session behavior will be labeled unverified rather than claimed as passed.
