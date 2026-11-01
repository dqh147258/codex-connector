# Security model

This is a **single-owner, local-development connector**, not a multi-tenant remote execution service.

## Trust boundaries

- The owner explicitly configures a Slack workspace, users, channels, project aliases, and an absolute Codex executable path. Empty/wildcard access is rejected. Any allowlisted user can issue natural-language tasks in a mapped thread; only allow people you trust with that project's effective Codex permissions.
- Messages, replies, local state, and generated final answers may contain project information. Choosing Slack authorizes sharing that content with the channel's members and Slack. There is no automatic secret scrubber for intentional model answers. Raw tool output/reasoning/stderr are not relayed.
- The local API binds only `127.0.0.1`, requires a long random bearer token, rejects browser Origin and non-loopback Host headers, and limits request bodies. It has no CORS endpoint, shell execution method, or arbitrary cwd/executable method.
- **The local bearer token controls all connector sessions**. It is not per-session authorization and does not isolate mutually untrusted local users, plugins, or repositories running as the same OS account. Do not publish the port or token. Local malware running as the owner is outside this boundary.
- Slack credentials belong only in the daemon environment. They are removed from the Codex subprocess environment. The Skill/CLI uses the private local API token, never Slack tokens. The CLI intentionally does not auto-forward requests/tokens through ambient HTTP_PROXY settings.
- Codex subprocesses use `shell:false`. Slack text is JSON input, never command arguments or a shell script. Configured `.cmd`/`.bat` launchers are rejected; JS launchers run under Node and native binaries execute directly.

## Codex policy

Default connector mode requests read-only sandboxing. Optional workspace-write mode explicitly passes the project writable root and disables sandbox network, subject to Codex's temporary-directory/platform rules and managed restrictions. Both legacy modes specify their own sandbox mode, so they do **not** promise to preserve every finer-grained restriction in a custom inherited profile. Existing approval policy, authentication, model, and reasoning-effort configuration are not overridden.

Explicit `sandbox: inherit` omits both legacy sandbox overrides. Use only after reviewing the effective local policy and confirming the desired narrow access. It can inherit a broader or more restrictive configuration; it does not enforce a new network policy. The connector never installs or modifies a permission profile. Named-profile experimental negotiation is not implemented without a version-pinned schema and real runtime validation.

Approval requests are declined, unknown interactive requests fail closed, affected turns stop and the queue pauses. No auto-accept/approve-session/allow-all flow exists. The Skill must not resolve failed work or relax permissions automatically. No blocked operation is tunneled through the connector.

## Delivery and state

Socket events are persisted before acknowledgement and deduplicated by Slack event ID. One managed session has one in-flight turn. Failed/uncertain jobs pause the queue; they are not automatically replayed. Job text and mappings are stored **unencrypted** in the private local state directory. Protect/back up this directory as sensitive data.

Atomic writes, file flushes and an exclusive lock reduce partial writes; this is not a distributed transaction with Slack or Codex. A crash can still leave an orphaned thread, ambiguous output, or effects already applied. Check actual Codex/Slack state before `resolve`. External Slack post retries do not provide exactly-once semantics. Event history is not backfilled during downtime.

A persistence failure restores the last committed in-memory snapshot and poisons further writes until restart. Do not blindly delete a stale daemon lock: first verify no connector or owned Codex process remains. The lock deliberately is not auto-stolen by PID heuristic.

## Secrets and permissions

`.gitignore` excludes local config/token/state/env/logs. Use a private home directory, not shared storage. POSIX creation modes are restrictive; on Windows inspect the directory ACL, since Unix mode bits are not a complete Windows access-control mechanism. Do not upload state files in bug reports. Test fixtures use dummy tokens and never connect to real Slack/Codex.

## Not implemented

No multi-workspace tenancy; no per-session local access tokens; no Slack approval UI; no file uploads; no Slack DM integration; no automatic recovery of missed offline events; no takeover of a user's busy live Codex session; no automatic service installation; no blanket network enabling. A narrow, validated proxy-aware Skill transport remains a future extension for runtimes that prohibit direct loopback access.
