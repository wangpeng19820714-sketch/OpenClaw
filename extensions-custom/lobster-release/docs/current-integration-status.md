# Lobster Release Current Integration Status

Last updated: 2026-03-22

## Scope

This document records the current live integration status of `lobster-release`, `OpenClaw`, Jenkins, and the `GameXpert_Godot` pipeline.

## Completed Capabilities

- `lobster-release -> Jenkins` trigger flow is live.
- Jenkins `resolve-baseline -> start -> publish -> finish` callbacks are live.
- Release creation, build tracking, approval, publish, and channel pointer switching are live.
- `release graph`, `build provenance`, and `rollback` core models are implemented.
- Android APK build and patch build are both wired into the release flow.
- Uploaded artifacts use immutable per-build directories:
  - `releases/<version>-<buildNumber>-<shortCommit>/...`
- `release_manifest.json` is generated and rewritten on approval.
- Published manifests expose stable release data, rollback target, provenance, baseline, and patch bundle URLs.
- `patch.bundleUrl` now points to the patch zip instead of a random patch content file.
- Baseline resolution now advances to the latest stable release in the same channel.
- Re-approving an already published release is idempotent and does not corrupt `previousReleaseId`.
- Jenkins callback provenance now reuses the trigger-created build instead of creating a duplicate build.
- Jenkins callback provenance now preserves baseline information even if callback payloads contain blank baseline fields.
- Rollback now rewrites the target release manifest after channel pointer switch.
- Rollback now marks the source release as `rolled_back` and can freeze the incident release.
- Rollback now blocks incompatible targets when `minClientVersion` or `resourceProtocolVersion` would regress.
- Failed build completion now leaves the release in `failed` state and does not publish the channel.
- Notification outbox is now implemented for `release.awaiting_approval`, `release.published`, `build.failed`, `build.canceled`, and `rollback.completed`.
- `lobster-release` now exposes notifier agent tools:
  - `release_notifications_drain`
  - `release_notifications_pull`
  - `release_notifications_ack`
  - `release_notifications_fail`

## Live Validation Results

The following live release regressions were completed successfully:

- `1.2.12`
  - fixed baseline manifest URL reuse
  - full `resolve-baseline -> start -> publish -> finish` chain validated
- `1.2.13`
  - immutable upload paths validated
  - manifest no longer mixed old build artifacts
- `1.2.14`
  - next patch baseline advanced to `1.2.13`
  - `patch.bundleUrl` fixed to patch zip
- `1.2.15`
  - provenance auto-backfill validated in live flow
  - baseline preservation fallback validated
- `1.2.16`
  - upstream Jenkins callback fix validated
  - no manual provenance backfill needed

## Current Verified State

- Current live channel:
  - `project = gamexpert`
  - `environment = staging`
  - `channel = beta`
- Current published release:
  - `1.2.16`
- Current Jenkins validation build:
  - `GameXpert_Godot_CI #42`
- Current manifest behavior:
  - `baseline.version = 1.2.15`
  - `patch.bundleUrl = GameXpert-patch-bundle-1.2.16-42-7617252.zip`
  - `provenance.jenkinsBuildNumber = 42`

## Upstream Jenkins Fixes Now Applied

These fixes were validated in the `GameXpert_Godot` Jenkins scripts:

- `load_env_file()` now exports loaded variables to child processes.
- `query_lobster_baseline.sh` persists `LOBSTER_BASELINE_VERSION`.
- `lobster_build_start.sh` sends:
  - `baseline.baselineVersion`
  - `baseline.baselineManifestUrl`
- `lobster_publish.sh` sends:
  - `baseline.baselineVersion`
  - `baseline.baselineManifestUrl`
- `lobster_build_finish.sh` sends:
  - `baseline.baselineVersion`
  - `baseline.baselineManifestUrl`

## Known Non-Blocking Follow-Ups

- Local integration config remains machine-specific and should keep real secrets in `.env`.
- Jenkins agent availability is still operationally important:
  - `local-macos` must stay online for this pipeline.
- Release flow is validated for Android APK + patch.
  - Android AAB and macOS app paths are designed, but not yet validated end to end in this live flow.
- Notification delivery is now validated through a real `pm` Feishu session.
  - `release_notifications_drain -> pm -> release_notifications_ack` completed successfully against a live outbox record.
  - `session_bound` delivery currently works by having the bound notifier session emit the final reply on its own delivery surface.
  - The notifier prompt has been tightened so `explicit_target` prefers the rendered `message` plan, while `session_bound` prefers bound-session replies and must not ack before actual send.

## Recommended Notifier Responsibilities

- `main`
  - owns operator-facing release actions and manual notifier recovery
  - may call `release_notifications_drain` and can keep `pull/render/ack/fail` for debugging and backfill
- `pm`
  - is the dedicated notifier worker
  - should have `message`, `release_notifications_pull`, `release_notifications_render`, `release_notifications_ack`, and `release_notifications_fail`
  - should be the only normal runtime agent that consumes notification outbox work
- `client`
  - should not act as the notifier worker
  - may keep normal messaging capability, but should not own lobster notification queue consumption
- other agents
  - should not carry notifier-specific tools unless they are intentionally acting as a backup notifier
- config rule
  - keep plugin exposure available through global `tools.alsoAllow`
  - keep per-agent `tools.allow` scoped to each role, so notifier worker tools do not drift into unrelated agents

## Recommended Next Steps

- Push both repositories so the current live-working state is preserved remotely.
- Decide whether `GameXpert_Godot` should keep using `local-macos` or move to a more stable dedicated agent.
- If needed, run one more regression for:
  - Android AAB
  - rollback execution
  - failed build callback path
- Build the dedicated notifier agent workflow and validate a real Feishu notification round trip.
- Decide whether notifier delivery should stay reply-driven for `session_bound` mode or move to an explicit message-tool path later.
