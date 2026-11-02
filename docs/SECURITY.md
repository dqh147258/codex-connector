# Security boundaries

## Single-owner control plane

This is not multi-tenant hosting. The local API token controls the owner's configured sessions/files, but cannot submit human approval/input decisions. Local malware or an untrusted process running as the same OS account can read/alter owner files; this connector is not an OS isolation boundary against that principal. Use a separate trusted account and appropriate filesystem/sandbox controls if needed.

Remote command authority comes from the configured workspace, input channel, exact botId/userId/appId tuple or allowlisted human userId. A known bot may request work but cannot authorize its own approval by claiming a human said yes. Output recipient selection is name→verified stable Slack user ID; changing the configured selector resolves a new target. The connector rejects its own bot messages to prevent feedback loops.

Strict whole-message markers and JSON schema disallow actor fields, arbitrary RPC, executable/cwd arguments, shell passthrough and remote service administration. Natural-language session text remains user/model content, never a shell argument. Direct command results and errors use the authenticated originating Slack thread (a top-level command becomes its own root); asynchronous session events use authorized stored bindings. Missing destinations never fall back to channel-top messages. Session control defaults to configured project roots/subdirectories; local-only sessionPolicy.allowAllSharedSessions can authorize other same-account shared sessions. Discovery paginates current shared-daemon loaded IDs plus indexed interactive non-archived history, retaining unknown metadata and scope/capability reasons. This setting never expands readonly file roots, creates a new sandbox grant, or permits Slack to change its own authority. New sessions still use configured project aliases.

## Human decisions

Only a direct authenticated allowed human in the correct bound thread, or an independently fetched unedited human decision envelope in that thread, authorizes a reply. The proof timestamp is a locator, not authority. Private/inaccessible context fails closed. Correlation includes request, connection epoch, session and turn; responses become stale on reconnect/restart and are not blindly replayed.

No accept-for-session or policy amendment exists. Missing/oversized/sensitive command or file scope, grantRoot expansion, unknown/secret prompts and unsupported human-verification flows remain local-only. Credential heuristics suppress common token/private-key/password patterns but are not universal DLP. Do not intentionally put secrets in Slack or ask the model to publish them.

Codex policy, authentication, model and reasoning remain inherited. The connector does not disable sandboxing, elevate itself, grant broad network/file access, or bypass managed requirements. A shared daemon can retain stricter original-owner/human approval routing; not all requests are necessarily remotely answerable.

## Readonly files

`list/stat/read/search` default to configured project roots with bounded traversal/output. The local-only, default-off `filePolicy.allowAbsolutePaths` opt-in also accepts native absolute paths without aliases, subject to the connector OS account permissions and the same guards. Enabling it requires explicit desktop confirmation (or an owner-edited local config), never a Slack command; trusted remote actors can then request system-wide readable data. This is separate from session control and never changes Codex sandbox permissions. They deny traversal, symlinks/junctions/hardlinks, special devices, credential paths and known secret content. Search is literal, not regex/shell. There is no remote write/delete/execute operation. Service templates are local text generation only.

Portable Node does not expose a universal descriptor-relative openat2-style API. Pre/post component and descriptor identity checks mitigate ordinary races but cannot guarantee safety against a hostile concurrent OS-level writer swapping path ancestors. Accessed file trees must be trusted and owned appropriately, or additionally isolated by the OS. File content scanning is defense-in-depth, not a complete secret classifier.

## Transport and storage

Socket Mode establishes outbound Slack connections. Local API binds127.0.0.1, requires a random bearer token, rejects browser Origin and unexpected Host, limits bodies and never follows redirects. The CLI uses a dedicated direct HTTP Agent with env proxy disabled. In proxy-only Codex sandboxes it may therefore be unavailable; do not disable policy to force it.

Slack credentials stay in the daemon environment and are removed from version/proxy child environments. No raw stderr/credential-bearing errors are sent to Slack. State is plaintext private local data containing accepted requests and pending/output text. POSIX creation modes are0700/0600; Windows ACLs require owner review. Protect backups and keep state/token/env files out of Git.

## Recovery and lifecycle

Accepted events persist before ack. Principal-scoped request IDs protect against duplicate execution; conflicts do not execute. In-flight ambiguity is recorded rather than rerun. Outbox delivery is separate from backend work; known rate-limit retry and uncertain delivery recovery never rerun Codex. Same-session deliveries cannot overtake an uncertain or backed-off predecessor.

Storage failure poisons mutations until a repaired restart; scheduling stops rather than spinning. State locks are never stolen automatically. Queued readonly inspections and decisions do not wait behind uncertain mutating controls. Operator recovery is local-only and must follow inspection.

An optional local-only default-off autoStartDaemon flag invokes only the official start command once after version probing. The expectedVersion pin is omitted by default; only an explicitly configured pin enforces an exact match. Runtime capability and protocol failures remain visible. That CLI may prepare its daemon package/manage its updater under existing Codex policy; the connector never modifies update policy or explicitly issues stop/update. It times out and exposes failure rather than repeatedly retrying or elevating. Only the connector's proxy connection is closed; the shared daemon and other clients' sessions are not killed. Startup/shutdown guards prevent a delayed handshake from reopening service after ownership is released. Service templates do not run install/uninstall commands, provision credentials, or elevate privileges.

## Explicit limitations

No guarantee for arbitrary older/newer app-server versions, standalone `--no-daemon` processes, unsupported subagents or protected original-owner approvals. No real Slack/Windows/macOS/shared-active-session end-to-end validation was completed here. Offline Slack event backfill, exactly-once external delivery, automatic migration from0.1, and turnkey privileged/prelogin service installation are not implemented.
