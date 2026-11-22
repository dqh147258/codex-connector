# Security boundaries

## Single-owner control plane

This is not multi-tenant hosting. The local API token controls the owner's configured sessions/files, but cannot submit human approval/input decisions. Local malware or an untrusted process running as the same OS account can read/alter owner files; this connector is not an OS isolation boundary against that principal. Use a separate trusted account and appropriate filesystem/sandbox controls if needed.

Remote command authority comes from the configured workspace, input channel, exact botId/userId/appId tuple or allowlisted human userId. Neither actor type can answer native requests through Slack. Output recipient selection is name→verified stable Slack user ID; changing the configured selector resolves a new target. The connector rejects its own bot messages to prevent feedback loops.

Strict whole-message markers and JSON schema disallow actor fields, arbitrary RPC, executable/cwd arguments, shell passthrough and remote service administration. Natural-language session text remains user/model content, never a shell argument. Direct command results and errors use the authenticated originating Slack thread (a top-level command becomes its own root); only fixed, proven same-origin status notices use authorized stored routes. Missing destinations never fall back to channel-top messages. Session control defaults to configured project roots/subdirectories; local-only sessionPolicy.allowAllSharedSessions can authorize other same-account shared sessions. Discovery paginates current shared-daemon loaded IDs plus indexed interactive non-archived history, retaining unknown metadata and scope/capability reasons. This setting never expands readonly file roots, creates a new sandbox grant, or permits Slack to change its own authority. New sessions still use configured project aliases.

## Native interaction stays in Codex

Only the original Codex UI handles native approvals and input. Slack and Connector local APIs cannot submit a native decision. Older approval command names, templates, reactions and alleged human proof grant no authority. No command/diff, question, options or other native interaction contents are sent to Slack; when a destination is proved, it receives fixed status only.

Expiry is Connector bookkeeping only. Even when the original Slack operation is known, a native client may have taken over before the expiry notification arrives. The timer does not re-read native content, send a decision/answer, interrupt the turn, or infer that Codex stopped. A currently known Slack origin can receive a fixed reminder; otherwise no outbound notification is attempted. Codex policy, authentication, model and reasoning remain inherited.

## Readonly files

`list/stat/read/search` default to configured project roots with bounded traversal/output. The local-only, default-off `filePolicy.allowAbsolutePaths` opt-in also accepts native absolute paths without aliases, subject to the connector OS account permissions and the same guards. Enabling it requires explicit desktop confirmation (or an owner-edited local config), never a Slack command; trusted remote actors can then request system-wide readable data. This is separate from session control and never changes Codex sandbox permissions. They deny traversal, symlinks/junctions/hardlinks, special devices, credential paths and known secret content. Search is literal, not regex/shell. There is no remote write/delete/execute operation. Service templates are local text generation only.

Portable Node does not expose a universal descriptor-relative openat2-style API. Pre/post component and descriptor identity checks mitigate ordinary races but cannot guarantee safety against a hostile concurrent OS-level writer swapping path ancestors. Accessed file trees must be trusted and owned appropriately, or additionally isolated by the OS. File content scanning is defense-in-depth, not a complete secret classifier.

## Transport and storage

Socket Mode establishes outbound Slack connections. Local API binds127.0.0.1, requires a random bearer token, rejects browser Origin and unexpected Host, limits bodies and never follows redirects. The CLI uses a dedicated direct HTTP Agent with env proxy disabled. In proxy-only Codex sandboxes it may therefore be unavailable; do not disable policy to force it.

Slack credentials stay in the daemon environment and are removed from version/proxy child environments. No raw stderr/credential-bearing errors are sent to Slack. State is plaintext private local data. It can contain accepted inputs, local results, or private records from a previous version; protect it even though native output cannot leave through Slack. POSIX creation modes are0700/0600; Windows ACLs require owner review. Protect backups and keep state/token/env files out of Git.

## Recovery and lifecycle

Accepted events persist before ack. Principal-scoped request IDs protect against duplicate execution; conflicts do not execute. In-flight ambiguity is recorded rather than rerun. Outbox delivery is separate from backend work; known rate-limit retry and uncertain delivery recovery never rerun Codex. Same-session deliveries cannot overtake an uncertain or backed-off predecessor.

Storage failure poisons mutations until a repaired restart; scheduling stops rather than spinning. State locks are never stolen automatically. Queued readonly inspections remain separate from recovery of uncertain mutating controls. Operator recovery is local-only and must follow inspection.

An optional local-only default-off autoStartDaemon flag invokes only the official start command once after version probing. The expectedVersion pin is omitted by default; only an explicitly configured pin enforces an exact match. Runtime capability and protocol failures remain visible. That CLI may prepare its daemon package/manage its updater under existing Codex policy; the connector never modifies update policy or explicitly issues stop/update. It times out and exposes failure rather than repeatedly retrying or elevating. Only the connector's proxy connection is closed; the shared daemon and other clients' sessions are not killed. Startup/shutdown guards prevent a delayed handshake from reopening service after ownership is released. Service templates do not run install/uninstall commands, provision credentials, or elevate privileges.

## Explicit limitations

No guarantee for arbitrary older/newer app-server versions, standalone `--no-daemon` processes, unsupported subagents or protected original-owner approvals. No real Slack/Windows/macOS/shared-active-session end-to-end validation was completed here. Offline Slack event backfill, exactly-once external delivery, automatic migration from0.1, and turnkey privileged/prelogin service installation are not implemented.
## RPC diagnostic privacy

JSON-RPC failures retain only a safe integer code and an allowlisted classification. Queue classifications require the exact method/code/message shape; no raw message or error data is copied into error objects, persisted delivery diagnostics or Slack output. Unknown wording is not displayed as a sanitized excerpt. Classification does not authorize a retry, resend, implicit steering, or a new turn, and does not itself establish message processing.

## Local clients and multiple shared daemons

[Local agent setup](LOCAL-AGENTS.md) separates agent bearer credentials from the operator token. Scope each agent to explicit server IDs, project aliases and commands, including event reads. MCP is a finite allowlist of public tools, not raw app-server RPC, a second daemon, a Slack bot, or a way to answer approvals. Keep the operator home and credentials unreadable to untrusted client processes; an application-level token scope does not isolate two processes that can read the same files. No client-selected URL, executable, Home, socket or origin is forwarded. An event cursor is not bearer authorization. Read/list operations remain scoped and absence after a gap is not proof of non-delivery.


### Native conversation visibility in Slack

In both Slack-only and dual mode, the official shared protocol cannot atomically prove that other native clients have not contributed to a turn. An echoed input ID and a complete history page can provide evidence about a particular action, not safe ownership of free-form output. The product never publishes native conversation bodies or native interaction text to Slack. Knowing a thread ID, binding, subscribing, disabling the local API, or finding a same-origin input ID does not create an exception.

Allowed Slack output includes safe structured metadata, command receipts and fixed lifecycle or interaction notices for proven original Slack work in its authorized origin. History/text search, overview and message excerpts, live commentary/partial/final output, generated titles, native error or approval/input text, result pages, queued or uncertain deliveries, and native replay cannot be used to get that content. `NATIVE_CONTENT_LOCAL_ONLY` signals this boundary; `LOCAL_ACTION_REQUIRED` directs users to the original Codex UI. An explicit authorized bound `session.reply` forwards only caller-authored text and is not a way to fetch or republish native output. Do not manually bridge the boundary with a local tool.

On upgrade, old native result pages and unproven/native outbox deliveries are not replayable; recovery is not permission to republish old bytes. Already-sent Slack messages are not modified. Safe status is not proof of full observation, and command completion is not proof Slack delivered its reply or the model finished.
