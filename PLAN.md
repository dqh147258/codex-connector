# Local and Slack entry points for known Codex App Servers (2026-11-22)

**Candidate, not a deployment.** The 2026-11-22 implementation plan was researched at the repository's default branch `master` (`798348e6037deb9d184dde01dde95f9d5e292dc0`). The actual implementation is based on `main` (`a27bf6a76ee1c3372b198576167f1f40f4208023`), 19 commits ahead with the original baseline as an ancestor. This keeps the existing Electron app, official WebSocket-over-proxy transport, durable Slack delivery and subscription features. Desktop setup changes in the candidate preserve imported multi-target and local-only configurations. Target for future review: **main**, not master. Do not deploy or merge this candidate based on mock results.

| Stage | Implementation and acceptance |
|---|---|
| 1. Route an authorized known server | The default official proxy inherits the invoking Home and receives no `--sock`; configured profiles can pin an existing Home/official socket and scope environment per child. Treat a profiled Home mismatch as a failure, not a fallback. `server.list` returns cached, authorized configuration only. A CLI version is not a server version or proof of the Desktop owner. |
| 2. Separate the transport entries | The CLI and genuine stdio MCP use a private authenticated loopback port. Slack-only does not require local credentials or open that port. A Slack credential/connection failure does not disable local entry. Validate commands, roots, origin and scopes independently of the model. Local operations and approvals never masquerade as Slack actions. |
| 3. Persist and reconcile | Per-server ledgers and pins, v2 backup/quarantine, immutable request IDs and work receipts, owner-specific bounded events/cursors, no automatic replay of uncertain native writes or Slack sends. Explicit verified attach is necessary to regain write access after a connection loss. |
| 4. Check real Windows, not inferred ownership | [Read-only preflight](docs/WINDOWS-CANDIDATE.md). Live dedicated thread tests are gated first on an authorized reachable native owner. Two Home, Desktop visibility and isolated production-like Slack each need separate evidence. Never scan private native storage, guess sockets, change host security settings or replace the Desktop daemon. |
| 5. Independent review | Hand off the same candidate SHA, regression output, environment limits and real Windows evidence to independent Codex Sol XHigh. No PR or release from this implementation phase. |

### Why the known-server list is intentionally incomplete

At the pinned [official CLI](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/cli/src/main.rs#L1525-L1534), proxy is a connection operation, not daemon start. [Home resolution](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/utils/home-dir/src/lib.rs) and [daemon location](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/app-server-daemon/src/lib.rs#L364-L387) show why separate Homes can lead to separate control endpoints. The [version query](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/app-server-daemon/src/lib.rs#L716-L727) addresses one Home. No supported whole-machine server registry was found in the inspected command surface. A process count, putative socket path, indexed conversation or CLI version cannot establish the writer of a Desktop session. The [official proxy](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/cli/src/app_server_proxy.rs#L12-L45) tunnels bytes; unlike native stdio, the shared [control socket](https://github.com/openai/codex/blob/1476a08f1b410e359e64becf2494bc248743e396/codex-rs/app-server-transport/src/transport/unix_socket.rs#L180-L245) requires WebSocket Upgrade.

Earlier project research informed three choices: [sender-scoped receipts](https://github.com/buidangminh23/codex-mcp-bridge/tree/ab1829f4aee9ecf5265d04a5a2a1ca8c309a803b), [bounded events and real stdio MCP tests](https://github.com/redmikarimo/codex-supervisor-mcp/tree/63d45d034ed7a88c5c0caa387a9f5409836bcd27), and [explicit message/owner correlation](https://github.com/fezdk/codex-sendmessage/tree/8e61a5cdce28b0732b99a406276d3b4462269b78). No third-party bridge, relay or independent daemon is part of the product.

---

# Codex Connector server redesign plan

Status: implementation and local fake integration complete; published as Draft PR #1 (https://github.com/dqh147258/codex-connector/pull/1), awaiting live acceptance. No merge.

This historical section describes the earlier standalone plan. Its remote decision and native text relay proposals are superseded by the current [native-output policy](docs/SECURITY.md#native-conversation-visibility-in-slack) and [interaction boundary](docs/PROTOCOL.md#native-requests-and-authority).

## Original required outcome (historical)

A least-privilege Windows/Linux/macOS background server receives strict, authenticated Slack bot command envelopes; manages sessions on the user's **default shared Codex daemon** where supported; routes each session to one output thread mentioning a configured, resolved dot user ID; supplies readonly project-file tools; and relays correlated approvals/user-input without autoapproval or policy bypass.

## Phases and acceptance gates

1. **Protocol and capabilities** — Pin generated schema expectations to the installed/tested Codex version. Prefer `app-server proxy --sock` to the configured default daemon. Surface connection/version/permission failures explicitly; never silently replace it with an independent server while claiming default-session takeover. List/info/history/attach/create/send/queue/steer/interrupt use explicit allowlisted RPCs and `canAcceptDirectInput`/runtime status checks.
2. **Command and trust boundary** — Exact whole-message marker lines plus a versioned JSON envelope; validate command parameters, target instance and request ID. Authenticate workspace/channel/bot/user from Slack metadata, not JSON claims. Generate complete help from command schemas. Suppress output loops and duplicate/replayed envelopes.
3. **Durable dispatch and delivery** — Persist accepted commands before Slack acknowledgement. Separate command execution from an ordered durable output queue; a Slack-send failure must never rerun a Codex operation. Mark crash/disconnect ambiguity and pause rather than blindly replay. Isolate session mappings and reconnect epochs.
4. **Approvals and user input (current review decision)** — The shared route relays only a fixed reminder to the known originating Slack conversation. Native decisions stay in Codex UI, and expiry changes the local reminder record only. The shared protocol lacks an atomic pending-request comparison before a turn interrupt; the timer never sends a decision, an answer, or an interruption.
5. **Readonly tools and startup** — Project-root-only list/stat/read/literal-search with traversal/symlink/junction/device/secret guards and strict limits. Generate platform-native login/prelogin service definitions with explicit least-privilege identity; local-only management, no remote service commands or automatic privilege escalation. Do not install/enable a real service here.
6. **Verification and publication** — Fake Slack/shared-app-server integration, delimiter/replay/source-auth tests, filesystem escape tests, pending-request misuse and disconnection tests, durable outbox tests, three-OS service generation tests, strict build/typecheck, secret scan and independent review. Publish a refactor branch and draft PR, verify the remote commit. No merge and no newly configured CI.

## Runtime evidence / limits

Installed research CLI: `0.166.0-alpha.1`. Its generated schema uses thread sandbox `read-only` (not the old implementation's `readOnly`), exposes shared-session rejoin on `thread/resume`, `canAcceptDirectInput`, and queue APIs. Shared-daemon launch currently fails in this execution environment (`package link escapes its root`); isolated thread creation also fails a sandbox-helper directory check. These are unresolved runtime acceptance gates, not a reason to disable protections. Existing user sessions and existing private session storage are not accessed.

Real Slack credentials, paid model turns, real user-session mutation, native Windows/macOS end-to-end validation, and service activation remain outside this implementation run. Any unproven shared-session behavior will be labeled unverified rather than claimed as passed.
