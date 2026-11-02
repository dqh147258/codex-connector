# Runtime capability evidence — 2026-11-02

## Allowed test scope

The user explicitly permitted starting Codex **to test app-server capabilities**, not to implement/write this connector. A separate research worker used isolated test configuration and no paid model turns. Implementation and all repository tests use handwritten TypeScript and a pure Node fixture. No real user sessions were modified. Existing private session storage was not read directly or through APIs.

## Observed installed CLI

- `codex --version`: `0.166.0-alpha.1`.
- CLI help exposes `app-server proxy [--sock SOCKET_PATH]`, daemon commands, shared `agents`, `queue --thread … --message … [--resume]`, and the `--no-daemon` opt-out.
- Generated current experimental JSON schemas were inspected. `thread/resume` explicitly describes rejoining an already-running thread; `Thread.canAcceptDirectInput` reports whether direct input is supported.
- The old connector's `thread/start sandbox: "readOnly"` was invalid for this CLI. Generated `SandboxMode` uses `"read-only"`. Version0.2 sends **no sandbox/approval/model overrides**, preserving the actual runtime policy rather than inventing spelling or weakening it.
- Queue schemas: `thread/queue/add {threadId,clientUserMessageId,input}`; `thread/queue/start {threadId,queuedSubmissionId?}`. Input replies use `{answers:{questionId:{answers:[…]}}}`.

## Actual probes that passed

- Isolated stdio `initialize` handshake.
- Read-only `thread/list` returned an empty isolated list.
- Read-only `thread/loaded/list` returned an empty isolated list.

These do **not** prove shared-proxy takeover, active turn execution, or cross-client callback ownership.

## Blockers observed (sanitized)

- Shared-daemon startup failed with `package link escapes its root`.
- Isolated daemon/control-socket connection failed with `EPERM`.
- Isolated `thread/start` failed a sandbox-helper socket-directory ownership/mode requirement.
- Inspection of metadata identified a sandbox-protected shared rendezvous directory, `/tmp/codex-daemon-<uid>`, with mode `000`. Changing `CODEX_HOME` does not move this fixed version-dependent rendezvous boundary.

The workers did **not** chmod that directory, disable sandboxing, use a new identity, or route around the restriction. No real new model turn, running-session attachment, steering, or approval reply was validated in this environment.

## Upstream source evidence (not an execution result)

OpenAI's repository source at commit `3026a8e54e0f48c4d8074cd700f35b0697abc329` includes live thread rejoin and pending-request replay to new connections. Callback consumption is synchronized and certain human-verification routes retain stricter owner/capability rules. The pinned thread_queue_processor source also rejects queue/start when a turn is active or pending; connector send therefore uses add/start instead of implicit-steering turn/start. This supports the architecture, not universal behavior across every installed binary. The local version's generated schemas remain the narrower integration reference.

## Connector behavior while blocked

Only the configured official shared proxy transport is used. The default-off local autoStartDaemon option can invoke the documented official daemon start once; this path is tested only with a fake executable here. Source shows start preserves a reachable running daemon, but may manage package/updater state under Codex existing policy. Failure is exposed in `capabilities`/`status`; no independent app-server fallback, auth-file scraping, rollout scanning, silent permission override, or process-wide daemon kill occurs. Existing server requests become stale on connection epochs; a new request must actually arrive after rejoin.

## Outstanding acceptance gates

1. On the user's normal machine, same-account default daemon/proxy connectivity and supported version.
2. Discovery/attach/send/steer/queue/interrupt against an explicitly authorized real test session.
3. Approval/user-input replay and resolution with two clients, including version-specific protected-human flows.
4. Actual Slack bot source metadata, dot name resolution/mention, and human-message-reference fetch permissions.
5. Native Windows/macOS process lifecycle and service startup; Windows S4U limitations may require login startup instead.

No broad claim that “all default sessions are controllable” is made before these gates pass.
