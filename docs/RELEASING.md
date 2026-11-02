# Prerelease automation

The owner authorized this release-only workflow. It is not a general push/PR CI pipeline.

- Normal trigger: push a new tag `vX.Y.Z-alpha.N`, `vX.Y.Z-beta.N` or `vX.Y.Z-rc.N`; the base X.Y.Z must equal package.json. Stable-looking tags are rejected and never published.
- One-time bootstrap: a master push changing `.github/workflows/prerelease.yml` whose head commit includes `[bootstrap-prerelease-v0.2.0-beta.1]`. It can publish only v0.2.0-beta.1 at that exact tested workflow-enabled commit. Ordinary master pushes do not publish. A conflicting tag or any existing release fails closed; no retagging or clobbering.
- The first workflow-enabled tag supersedes the earlier manually prepared 801a3ddd candidate: release metadata records the actual tested commit, never falsely claims the original SHA.
- Build/test uses read-only contents access, Node22 and npm ci --ignore-scripts, pure fake tests, then a production-only extracted-package smoke test. It never invokes a real Codex or Slack.
- Only the isolated publish job has contents:write. It does not check out or execute repository/npm scripts. It verifies the six artifact filenames, checksums, commit identity and immutable tag, creates a draft prerelease, checks GitHub asset digests, then publishes as prerelease with latest=false.
- Standard GITHUB_TOKEN is the only credential. No personal token, extra secret, settings change or privileged workflow is needed. A permission/policy rejection is a blocker, not a reason to bypass it.
- Release consists of source and portable Node archives, MACOS-SETUP.md, RELEASE-INFO.json, release notes and SHA256SUMS. No node_modules, host config, service installation or npm publishing.
- A failed publish after draft creation leaves a draft for owner inspection; reruns do not overwrite it. Inspect before choosing a new version or explicitly cleaning up the failed draft. Never delete a conflicting existing tag automatically.

From an authenticated owner checkout, after reviewing/committing changes and updating the package base version when necessary:

```sh
git tag v0.2.0-beta.2 <reviewed-commit>
git push origin refs/tags/v0.2.0-beta.2
```

Wait for both build and publish jobs to finish; verify the release tag points to the intended SHA and download checksums match. Native macOS, real Slack/shared-session control, sleep/wake and service startup remain separate user acceptance gates, not inferred from green Actions.
