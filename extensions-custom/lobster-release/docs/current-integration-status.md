# Lobster Release Current Integration Status

Last updated: 2026-03-26

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
- Repeated Jenkins `start / publish / finish` callbacks now preserve the latest build state instead of regressing it.
- Repeated Jenkins `publish` callbacks now deduplicate artifacts for the same build.
- Patch publish now validates local `patch_manifest.json` schema before accepting the artifact set.
- Patch publish now rejects conflicting `patch_list.json` entries when the uploaded patch metadata is locally accessible.
- Jenkins callback provenance now reuses the trigger-created build instead of creating a duplicate build.
- Jenkins callback provenance now preserves baseline information even if callback payloads contain blank baseline fields.
- Rollback now rewrites the target release manifest after channel pointer switch.
- Rollback now marks the source release as `rolled_back` and can freeze the incident release.
- Rollback now blocks incompatible targets when `minClientVersion` or `resourceProtocolVersion` would regress.
- Failed build completion now leaves the release in `failed` state and does not publish the channel.
- Notification outbox is now implemented for `release.awaiting_approval`, `release.published`, `build.failed`, `build.canceled`, and `rollback.completed`.
- `lobster-release` now exposes notifier agent tools:
  - `release_notifications_drain`
  - `release_notifications_render`
  - `release_notifications_pull`
  - `release_notifications_ack`
  - `release_notifications_fail`
  - `release_notifications_requeue`
- Notification delivery now has runtime recovery rules:
  - timed-out `sending` claims are reclaimed automatically
  - `failed` notifications retry with backoff before becoming manual-only
  - operators can manually requeue a notification without mutating release state
- Notification recovery path is now validated end to end with `bot_pm`:
  - forced failure against an invalid Feishu `open_id`
  - automatic backoff confirmed
  - manual `release_notifications_requeue` confirmed
  - final resend confirmed through `bot_pm`
- Repo-local notifier drain is now validated end to end:
  - `release_notifications_drain -> agent:pm:main -> message -> release_notifications_ack`
  - the `pm` notifier can consume a live outbox record and deliver it through Feishu using the rendered `message` plan

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
- `1.2.17`
  - Android AAB live publish path validated end to end
  - Jenkins `GameXpert_Godot_CI #43` completed with `SUCCESS`
  - final manifest contains `GameXpert-android-aab-1.2.17-43-e559149.aab`
  - no patch payload was generated for this release
- `1.2.18`
  - macOS app live publish path validated end to end
  - Jenkins `GameXpert_Godot_CI #44` completed with `SUCCESS`
  - final manifest contains `GameXpert-macos-app-1.2.18-44-e559149.zip`
  - no patch payload was generated for this release
- `2026-03-26 notifier failure drill`
  - first `bot_pm` delivery intentionally failed with Feishu `400 / invalid open_id`
  - failed notification did not retry immediately because backoff was active
  - manual `release_notifications_requeue` returned the item to `pending`
  - resend succeeded with Feishu message id `om_x100b53676d6124a0c34c3bcd56b9f57`
- `2026-03-26 repo-local notifier drain`
  - `release_notifications_drain` started `agent:pm:main` and waited successfully
  - `pm` rendered the notification in `session_bound` mode and used the `message` tool to send it to Feishu
  - the live outbox record reached `sent` with Feishu message id `om_x100b53672b5a84b4c4257e0ed319de2`
- `2026-03-26 rollback drill`
  - beta rolled back from `1.2.16` to `1.2.15` with `pointer_switch`
  - `rollback.completed` notification for `rbk_mn7izu1w_9e700e37` was sent by `pm`
  - beta was restored from `1.2.15` back to `1.2.16`
  - restore notification for `rbk_mn7j1oji_37232e20` was sent by `pm`
- `2026-03-26 failed build callback drill`
  - live `ci.build.start -> ci.build.finished(FAILURE)` callback path validated against project `gamexpert-faildrill`
  - build `bld_mn7jjdqb_5374c0d8` finished as `failed`
  - release `rel_mn7jjdqb_0a5921b5` remained `failed`
  - channel state stayed `null`, so the failed callback did not publish or move any pointer
  - `build.failed` notification `ntf_mn7jjdqd_6c06e242` was queued with the expected summary and failed stage
- `2026-03-26 repeated callback idempotency drill`
  - isolated live drills validated repeated `start / publish / finish` handling against `gamexpert-idempotency-*` projects
  - repeated `start` reused the same build id instead of creating a duplicate build
  - repeated `publish` kept artifact count stable at `1` for the same build
  - repeated `finish` kept `release.status = awaiting_approval` without duplicating side effects
  - repeated `start / publish` after `finish` did not regress `build.status` from `finished`
  - repeated `finish` after approval kept the release in `published` state
- `2026-03-26 patch validation local regression`
  - local patch publish now accepts a valid `patch_manifest.json` + `patch_list.json` pair and records `build.reports.patchValidation`
  - local patch publish now rejects duplicated normalized paths in `patch_list.json`
  - remote-only callback payloads without locally accessible patch metadata are marked as skipped validation instead of failing publish
- `2026-03-26 live Jenkins patch conflict drill`
  - real Jenkins patch-only build `GameXpert_Godot_CI #45` uploaded `1.2.19` patch artifacts under `releases/1.2.19-45-e559149/...`
  - the uploaded real `patch_list.json` was intentionally rewritten with a conflicting duplicate normalized path before replaying the Jenkins callbacks
  - repo-local `lobster-release` rejected the replayed `publish` callback with `patch_list contains conflicting paths: packages/hotfix_package/raw/assets/conf/bytes/conditiontable.bytes`
  - release `1.2.19` (`rel_mn7l2ow1_b6a57696`) and build `bld_mn7l2ow2_66127338` both ended in `failed`
  - `staging/beta` stayed on `current=1.2.18`, `previous=1.2.17`, so the failed patch publish did not move the live pointer

## Current Verified State

- Current live channel:
  - `project = gamexpert`
  - `environment = staging`
  - `channel = beta`
- Current published release:
  - `1.2.18`
- Current Jenkins validation build:
  - `GameXpert_Godot_CI #44`
- Latest conflict validation build:
  - `GameXpert_Godot_CI #45`
  - intentionally failed at `publish` after patch conflict injection
- Current manifest behavior:
  - `artifacts[macos_zip] = GameXpert-macos-app-1.2.18-44-e559149.zip`
  - `patch = null`
  - `provenance.jenkinsBuildNumber = 44`
  - `rollbackTarget = rel_mn7jr6sz_1d2bcb14`

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
  - Android AAB is now validated end to end in this live flow.
  - macOS app is now validated end to end in this live flow.
- Rollback execution is now validated in a real live drill.
  - `1.2.16 -> 1.2.15 -> 1.2.16` completed successfully
  - channel state returned to `current=1.2.16`, `previous=1.2.15`
  - both rollback notifications were delivered through `pm`
- Notification delivery is now validated through a real `pm` Feishu session.
  - `release_notifications_drain -> pm -> release_notifications_ack` completed successfully against a live outbox record.
  - In the current live `pm` setup, `session_bound` delivery resolved to the rendered `message` tool plan and sent to the bound Feishu direct chat.
  - The notifier prompt has been tightened so `explicit_target` prefers the rendered `message` plan, while `session_bound` must not ack before actual send and may use the rendered message plan when present.
- Notification recovery policy is now validated in a live failure drill.
  - failed deliveries back off from 1 minute and stop auto-retrying after 5 attempts.
  - manual recovery should use `release_notifications_requeue` after operator review.
  - `bot_pm` resend after manual recovery is confirmed working.
- Patch conflict handling is now validated in a real Jenkins drill.
  - a conflicting `patch_list.json` is rejected during `publish`
  - the release and build move to `failed`
  - the live beta pointer remains on the previously published release

## Recommended Notifier Responsibilities

- `main`
  - owns operator-facing release actions and manual notifier recovery
  - may call `release_notifications_drain` and can keep `pull/render/ack/fail/requeue` for debugging and backfill
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

## Notification Recovery Rules

- claim timeout
  - `sending` records are not trusted indefinitely
  - if a notifier claims work and does not ack/fail within 5 minutes, the next `release_notifications_pull` reclaims that record and marks it `failed`
- retry backoff
  - auto-retry starts from 1 minute after the failure
  - each later retry doubles the wait window
  - after 5 total attempts, the record stops auto-retrying and stays failed until an operator intervenes
- manual recovery
  - use `release_notifications_requeue` only after the failure reason is understood
  - manual requeue clears terminal retry state but preserves audit history such as attempt count and last event linkage
- notifier scope
  - the notifier worker should only `pull -> render -> send -> ack/fail`
  - manual requeue belongs to an operator-facing session such as `main`, not to the normal notifier worker

## Recommended Next Steps

- Push both repositories so the current live-working state is preserved remotely.
- Decide whether `GameXpert_Godot` should keep using `local-macos` or move to a more stable dedicated agent.
- Decide whether notifier delivery should stay reply-driven for `session_bound` mode or move to an explicit message-tool path later.
