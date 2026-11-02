# Electron desktop implementation plan

Status: desktop implementation and local automated QA complete; independent security review passed. Both native macOS arm64/x64 build, bundled runtime and mock-UI screenshot jobs passed at commit 43960e6; the narrow Slack block-transport compatibility delta requires its own CI rebuild. Live Slack/shared-session, Keychain and login-item acceptance remain pending. No Codex is used to implement this application.

## Goal
Turn the existing connector into a desktop application for ordinary users: guided local setup, clear Slack identity lookup, private credential storage, observable connection tests, start/stop/diagnostics and explicit login startup. Preserve the reviewed server protocol, permissions and durable state model.

## Phases / acceptance
1. **Safe desktop boundary**: isolated/sandboxed renderer, restrictive CSP, validated narrow preload IPC, single instance; main owns config, secrets, process lifecycle and OS integration. No arbitrary shell, RPC, path writes or external URL opening.
2. **Setup and identity**: graphical fields explain where each ID comes from; masked tokens never returned from main; Slack token tests and workspace/dot lookup with existing minimal scopes; channel manual fallback and optional enumeration only with explicitly granted read scopes. Import existing config requires review/save and does not silently migrate or overwrite it.
3. **Local service lifecycle**: bundle Electron + all runtime dependencies (no npm ci for end users); test configured Codex/version without default pin; start only one owned connector child; stop/quit idempotent and do not kill shared daemon. Status distinguishes local server/Slack readiness/shared backend readiness. Stale-lock recovery is explicit, same-user PID-absent and unchanged-lock checked, backup only.
4. **Settings**: separate login-startup and auto-connect switches, default off; native OS state readback and explicit user click confirmation; no prelogin-service claim. Tray/close behavior explicit, Quit stops owned service. Native macOS and Windows integration where supported; Linux limitation reported honestly rather than faked.
5. **Distribution and validation**: deterministic app build with production dependencies, macOS arm64/x64 packaging definitions (unsigned/non-notarized unless owner supplies signing later), Windows/Linux build targets; existing tests plus mock desktop boundary/lifecycle/lookup/startup tests, renderer smoke/screenshots where possible. New feature branch + Draft PR, no merge or tag replacement.

## Non-goals / safeguards
No remote deployment, service enablement, credential entry or real Slack calls here. No model calls, auth/session scraping, sandbox changes, broad Slack scopes granted silently, existing-user-session modification, auto approval, force process-name killing or deletion of state/token files. Unsigned distribution is disclosed without instructions to bypass OS protections. Actual host integration requires explicit user acceptance.
