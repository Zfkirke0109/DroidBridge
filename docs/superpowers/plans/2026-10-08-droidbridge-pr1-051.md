# DroidBridge PR #1 0.5.1 Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement each checked task, test it, and review the final branch.

**Goal:** Update fork PR #1 to a tested, secure DroidBridge 0.5.1 standalone Claude connector and merge it into the fork's `main` while retaining a separately installable debug APK.

**Architecture:** The Cloudflare Worker and Durable Object provide an HTTPS MCP/OAuth endpoint. The standalone Android app maintains an outbound authenticated poll and serves MCP requests through its existing runtime. Git history joins the old PR #1 head to the validated 0.5.1 tree without restoring obsolete `app/` or root-daemon services.

**Tech stack:** Kotlin/Compose, Android AIDL, Rust 1.98.0, Node 22+, Cloudflare Wrangler 4, GitHub CLI.

**Spec:** `relay/DESIGN.md`, `relay/README.md`, and the old PR #1 code and tests at `fa3d9c3`.

## Global constraints

- Preserve public relay routes and the `droidbridge-relay/1` phone protocol unless a demonstrated security or correctness defect requires a coordinated Worker/phone change.
- Keep the debug Android package `com.droidbridge.standalone.debug` installable next to the official 0.5.1 package. Do not publish a release APK.
- Scope Claude relay support to the standalone edition; the root-edition relay is a separate project. Preserve or prove equivalent every applicable behavior and safety guarantee from PR #1.
- Never commit device keys, OAuth tokens, Cloudflare credentials, private logs, or phone dumps.
- Leave PR #1 draft and unmerged until all automated, security, and live-device gates pass.

## Review focus

- A wrong or expired pairing code must grant no access; a valid code works once.
- A revoked or rotated credential must stop old access, including after app or Worker restart.
- A delivered request whose result is uncertain must never be silently retried.
- A dead or unhealthy runtime must not report ready or execute a stale request.
- Long-running idle polling must not crash, leak memory, or keep the phone thermally active.

### Task 1: Preserve PR #1 behavior and checks

- [ ] Compare each PR #1 changed behavior/test with the 0.5.1 integration tree and record its new location, equivalent upstream behavior, or demonstrated obsolete status in the PR body.
- [ ] Restore PR #1's pre-commit JSON/TOML/YAML, private-key, gitleaks, file hygiene, and merge-conflict checks with narrow 0.5.1 fixture exclusions; run `uvx pre-commit run --all-files` and watch it pass.
- [ ] Restore the phone Rust tests for authenticated poll/response, exactly-once host execution, malformed device key, and invalid HTTPS origin in `rust/crates/app_native/src/remote_relay.rs`. Run the focused tests and formatting check.
- [ ] Re-express the old runtime-health JVM, Rust, and device assertions against 0.5.1. Write a failing current-architecture regression for each uncovered safety invariant, implement the minimal safeguard, then rerun the targeted and full suites.
- [ ] Add an Android device test covering Claude connector cold start, runtime/service recovery, and state after app restart.

### Task 2: Review security and verify builds

- [ ] Review every Worker/phone trust boundary: OAuth PKCE, audience, redirects and metadata fetches, device authentication, pairing attempts, token replay, cancellation, response settlement, local key storage, and log redaction. Write a reproducing test before each fix.
- [ ] Audit `rust/Cargo.lock` and the pinned Wrangler version; resolve reachable high/critical findings or document why an advisory is unreachable.
- [ ] Run `node --test` in `relay/`; `cargo +1.98.0 test --locked --workspace` and Android arm64 Clippy with warnings denied in `rust/`; Android shared/standalone unit tests, standalone/root lint, and standalone/root debug builds. Run targeted tests after changes, then the full gate once.
- [ ] Rebuild the standalone debug APK from the final commit and record package ID, version, signature, hash, and installation result on the S23.

### Task 3: Deploy and exercise the connector

- [ ] Confirm Cloudflare authentication. Wrangler on the PC currently reports signed out; use the user's Termux Wrangler installation if it can access the relay source and account, otherwise complete interactive PC Wrangler login. Do not copy an OAuth token between devices.
- [ ] Deploy the Worker with `relay/wrangler.toml`, generate a new device key privately, set only its SHA-256 as `DEVICE_KEY_SHA256`, and configure the debug app with the relay URL and raw key. Verify public origin and OAuth metadata without exposing credentials.
- [ ] Pair a Claude custom connector with the one-use phone code and run `tools/list` plus a harmless read-only MCP call.
- [ ] Test wrong/reused/expired codes, unauthorized device calls, token refresh/revoke/rotation, offline and aborted requests without replay, screen lock, network reconnect, app/process restart, reboot, and a sustained idle battery/memory/thermal check. Keep sensitive values out of artifacts.

### Task 4: Update and merge PR #1

- [ ] Re-fetch both remotes and assert fork `main` is an ancestor of pinned upstream 0.5.1 base `a1b47e3`. Fast-forward fork `main` to that commit without force.
- [ ] On the fully tested integration tree, merge old PR #1 head `fa3d9c3` with the `ours` strategy as a second parent; verify the merge tree is byte-for-byte identical to the tested tree and fast-forward-push it to PR #1's existing head branch.
- [ ] Rewrite PR #1 title/body with the parity ledger, tests, security review, device evidence, root-edition limitation, and debug-only status. Verify its GitHub comparison is against 0.5.1; refresh the base comparison if GitHub pins the old base. Attach the PR to the Codex task.
- [ ] Require green PR checks and an independent final review, no known reproducible defect, and no unmitigated reachable high/critical security finding. If any gate fails, keep PR #1 draft, fix, and rerun affected gates. Otherwise mark it ready, merge it into fork `main`, and close PR #2 as superseded.

