# Runtime capability evidence — 2026-11-02

## Operator-reported local macOS verification after the proxy transport fix

The following evidence was supplied in the operator’s uploaded commit `bd79e3df215db35f096c9d40beba19f716213687`; desktop package integration preserves this report and does not claim to have independently repeated these live checks.

The operator requested that the already-configured local app be made runnable. Read-only checks confirmed valid Slack bot authentication, the configured workspace, and dot's exact bot/user/app identity. An exited connector had left a stale lock; its PID and the unused API port were verified before removing that lock.

The invoking Codex environment inherited a `CODEX_HOME` for a separate proxy installation. Clearing that override for this connector launch let the official CLI select the ordinary user's existing shared daemon. No daemon restart, update, socket permission change, or session policy change was needed.

- Installed CLI: `0.165.0`; running shared app-server: `0.166.0`.
- The official `app-server proxy` is a raw byte tunnel, **not** a newline-delimited JSON server. Sending JSON lines did not initialize it. An HTTP WebSocket upgrade returned `101 Switching Protocols`.
- The corrected connector performs the WebSocket upgrade over the same official proxy's stdin/stdout, then exchanges JSON RPC messages in text frames. It retains the RPC allowlist, credential filtering, and bounded message size.
- The corrected backend completed `initialize` / `initialized` against the existing daemon. Read-only `thread/loaded/list` returned 21 IDs at verification time; `thread/list` returned metadata and a pagination cursor. No session content is included in this report.
- The local fixture now requires the real HTTP upgrade and WebSocket framing. Regression checks cover fragmented responses with interleaved ping, rejected upgrades, binary/oversized messages, disconnect/reconnect, and proxy shutdown without a lingering WebSocket close timer.
- Slack Socket Mode started successfully; both configured channels passed read-only history access checks. The fixed connector runs as a detached background process with private logs. Its authenticated local API returned `connected:true` and `lastFailure:null` on `127.0.0.1:17381`.
- The background maintenance loop now skips overlapping ticks instead of accumulating reconnect retries that could delay shutdown. `npm test` passed all 77 tests.

No paid model turn, session attachment, steering, interruption, human approval, or Slack message was sent during these checks. Those remain separate acceptance gates. The evidence below records the earlier restricted-environment investigation and its historical blockers.

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

1. Same-account default daemon/proxy connectivity on native Windows and other untested environments; local macOS connectivity passed as recorded above.
2. Discovery/attach/send/steer/queue/interrupt against an explicitly authorized real test session.
3. Approval/user-input replay and resolution with two clients, including version-specific protected-human flows.
4. Actual Slack command event delivery, output mentions, and human-message-reference fetch permissions; local authentication, dot identity resolution, Socket Mode connection, and channel history access passed.
5. Native Windows/macOS process lifecycle and service startup; Windows S4U limitations may require login startup instead.

No broad claim that “all default sessions are controllable” is made before these gates pass.
