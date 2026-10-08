# PR #1 to DroidBridge 0.5.1 parity ledger

This ledger tracks the old PR #1 (`fa3d9c3`, based on the fork's 0.4.x tree) against the standalone 0.5.1 integration. It is a merge gate, not a claim that all behavior is verified.

| Old PR #1 change | 0.5.1 location or disposition | Verification still needed |
| --- | --- | --- |
| `6cf800e`, `fbe60b8`, `bb5f980`, `934ad8d`, `961f1dc`, `eafff2d`, `fa3d9c3`: Cloudflare Worker, OAuth, pairing, exact JSON-RPC forwarding, no-replay settlement | `relay/src/` and `relay/test/` are byte-identical to the old PR. The README has six additions and two removals for the new app layout. | Independent trust-boundary review; security regressions; deployed Worker and Claude pairing. |
| `386796d`: native phone relay client | `rust/crates/app_native/src/remote_relay.rs` and the standalone JNI/runtime service. Old authenticated poll/response and URL/key tests were restored. | Full Rust suite, device connection, offline/reconnect, cancellation and idle checks. |
| `4beda71`, `20ff260`: Runtime-owned settings, lifecycle, Agent connection and Home screens | `standalone/src/main/.../runtimehost/ClaudeRelaySettingsController.kt`, `ui-common/src/main/.../mcp/ClaudeConnectorScreens.kt`, related projections/tests. | Android unit and device tests, including process recovery and app restart. |
| `51b464a`: recognize Shizuku+ | Ported in `fc31751` to standalone package detection. | Android device and unit verification. |
| `20df879`: pre-commit checks | Restored in `.pre-commit-config.yaml`; full file hygiene and Gitleaks run passed. | CI run on the final PR head. |
| `1a75697`, `87e4bf6`: APK Runtime health gate | 0.5.1 has native lease, readiness, store-write recovery; `c60a25e` adds exact cached-session fence validation before JNI submissions and fail-closed diagnostics. | Still absent: canonical deep read/private fsync scratch write/JNI executor probe, bounded suspicious-result reprobe, quarantine and release-pending drain, fault telemetry, breaker/backoff, successor establishment, foreground task-count reset. Each needs an equivalent or a justified 0.5.1 replacement before merge. |
| `abcd537`, `811aac8`: upstream 0.4.3 baseline/merge | Superseded by the pinned upstream 0.5.1 commit `a1b47e3`; fork `main` at `534d154` is an ancestor of it. | Re-fetch and recheck before updating fork `main`. |
| `a7182b8`: trailing blank-line cleanup | Current file-hygiene hooks pass on the integration tree. | None beyond final hook run. |
| Root-daemon, Magisk and root-edition portions of old health-gate changes | Outside the agreed standalone 0.5.1 connector scope; root-edition relay remains a separate project. | Do not describe these as ported to standalone or as merged functionality. |

The 0.5.1 integration also keeps `com.droidbridge.standalone.debug` separate from the official package. No release APK is part of this PR. The old PR remains draft until the open verification cells and the implementation plan's live gates close.
