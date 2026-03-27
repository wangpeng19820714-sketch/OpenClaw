# Lobster Release Current Integration Status

Last updated: 2026-03-27

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
- Version governance is now enforced in runtime.
  - release versions must stay in strict `major.minor.patch`
  - duplicate versions in the same `project/environment/channel` are rejected
  - next-version suggestions are available by `patch / minor / major`
- Existing releases can now be manually retriggered through `release_trigger`.
- Re-approving an already published release is idempotent and does not corrupt `previousReleaseId`.
- Repeated Jenkins `start / publish / finish` callbacks now preserve the latest build state instead of regressing it.
- Repeated Jenkins `publish` callbacks now deduplicate artifacts for the same build.
- Patch publish now validates local `patch_manifest.json` schema before accepting the artifact set.
- Patch publish now rejects conflicting `patch_list.json` entries when the uploaded patch metadata is locally accessible.
- Callback ingress now enforces signed timestamp freshness, nonce replay protection, and idempotency receipts.
- Callback ingress now has minimal anti-abuse protection.
  - callback routes are rate limited per route and remote address
  - failed callback execution now records `callback.failed` audit events
  - retryable callback failures now return a `Retry-After` hint to upstream callers
- Artifact publish now enforces integrity and naming rules.
  - locally accessible artifacts are re-hashed and compared against reported SHA-256
  - versioned release artifacts must include the release version
  - versioned release artifacts must include Jenkins build number when one exists
- Build provenance now accepts archived Jenkins environment snapshots.
  - optional callback payloads can persist Godot version, export presets, config version, script versions, and fingerprint metadata
  - archived CI environment details are merged into provenance instead of replacing earlier fields with blanks
- Publish now runs a smoke gate that blocks missing required artifacts before a build can advance to `uploaded`.
- Patch publish now checks patch compatibility metadata when it is present in the uploaded manifest schema.
- Jenkins callback provenance now reuses the trigger-created build instead of creating a duplicate build.
- Jenkins callback provenance now preserves baseline information even if callback payloads contain blank baseline fields.
- Rollback now rewrites the target release manifest after channel pointer switch.
- Rollback now marks the source release as `rolled_back` and can freeze the incident release.
- Rollback now blocks incompatible targets when `minClientVersion` or `resourceProtocolVersion` would regress.
- Active rollback requests now block ordinary trigger, approve, and promote flows on the same channel until rollback finishes.
- Failed build completion now leaves the release in `failed` state and does not publish the channel.
- Notification outbox is now implemented for `release.awaiting_approval`, `release.published`, `build.failed`, `build.canceled`, and `rollback.completed`.
- `lobster-release` now exposes notifier agent tools:
  - `release_notifications_drain`
  - `release_notifications_render`
  - `release_notifications_pull`
  - `release_notifications_ack`
  - `release_notifications_fail`
  - `release_notifications_requeue`
- `lobster-release` now exposes operational query tools:
  - `release_build_status`
  - `release_preflight`
  - `release_generate_notes`
  - `release_trigger`
  - `release_version_suggest`
  - `release_store_status`
  - `release_maintenance_run`
  - `release_stable_list`
  - `release_channel_history`
  - `release_baselines`
  - `release_baseline_lineage`
  - `release_promote`
  - `release_promote_history`
  - `release_rollback_audit`
  - `release_rollback_assist`
  - `release_build_status` can also poll Jenkins live queue/build state when requested
- Release promotion is now implemented as a first-class runtime flow.
  - a stable published release can be promoted into another channel/environment
  - promotion generates a fresh target-channel manifest while reusing the validated source build
  - promotion writes `promoted_from` relation edges and appears in promote history queries
- Release changelog archiving is now implemented.
  - approval, auto-dev publish, and promotion archive release notes into `release.changelog.archived` events
  - agent callers can fetch archived or live notes through `release_generate_notes`
- Rollback audit capture is now persisted on the rollback record.
  - completed rollback records now keep `channelStateBefore`, `channelStateAfter`, and source/target status snapshots
- Build start notifications are now emitted when a build first enters `building`.
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
- Store maintenance and retention are now implemented.
  - store schema version metadata is initialized at startup
  - maintenance can dry-run or execute artifact, manifest, event, notification, and idempotency cleanup
  - protected releases keep current/previous pointers, frozen releases, and recent stable history intact
- Project policy scaffolding is now implemented for multi-project operation.
  - per-project defaults can define environments, channels, approval policy, regions, audiences, gray release percentages, scheduled builds, and smoke workflows
  - release creation, CI baseline resolution, and CI callback normalization now resolve project/environment/channel through project policy instead of only using global defaults
- Gray release planning and project catalog queries are now implemented.
  - operators can query project policy catalogs and gray rollout plans before wiring live traffic controls
- API integration skeleton is now implemented and validated locally.
  - HTTP tests cover project catalog, gray plan, release creation, release graph, callback nonce replay rejection, store status, and maintenance endpoints
- Local operator workflow now has a dedicated dev start entrypoint.
  - `pnpm lobster:dev` starts the gateway with `configs/openclaw.json`

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
- `2026-03-26 callback security and smoke gate local regression`
  - duplicate callback nonces are now rejected after the first successful claim
  - successful callback responses are now cached by idempotency key and request hash
  - patch publish with only `patch_manifest` and no `patch_bundle` is now blocked by `publish smoke gate failed: required artifact missing: patch_bundle`
- `2026-03-27 promote and audit local regression`
  - local runtime flow validated `release_preflight`, `release_generate_notes`, `release_promote`, `release_promote_history`, `release_baseline_lineage`, and `release_rollback_audit`
  - promote created fresh release-channel records while reusing source build artifacts and manifests
  - baseline lineage for `1.0.3` resolved as `1.0.2 -> 1.0.3`, `1.0.1 -> 1.0.2`, and `1.0.0 -> 1.0.1`
  - rollback audit entries now contain `manifestAction.audit` snapshots after completion
- `2026-03-27 maintenance and provenance snapshot local regression`
  - local CI provenance updates now merge optional `environmentInfo` without dropping previously captured baseline or executor metadata
  - local maintenance dry run identified only non-protected releases for artifact cleanup
  - store status now reports schema version, counts, and retention configuration
  - a requested rollback now blocks ordinary `approve-release` on the same channel until rollback is resolved
- `2026-03-27 project policy and API skeleton local regression`
  - per-project policy isolation validated with distinct environment and channel defaults
  - gray rollout plan queries now return configured percentages, region, audience, scheduled build, and smoke workflow scaffolding
  - HTTP integration tests validated `GET /projects`, `GET /projects/:projectKey/policy`, `GET /projects/:projectKey/channels/:channel/gray-plan`, release creation, release graph, callback nonce replay rejection, store status, and maintenance routes

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
- Callback hardening is now in place for both CI and signed build callbacks.
  - duplicate request bodies can be served from idempotency receipts
  - replayed nonces are rejected before callback logic is re-executed
- Publish smoke gate is now active.
  - required artifacts must exist before a build can move to `uploaded`
  - patch compatibility metadata is checked when the uploaded patch manifest schema exposes it
- Promote/history/lineage/audit/note generation are now implemented and locally validated.
  - they still need a dedicated live operator drill on the real `gamexpert` project before being treated as fully live-verified

## Recommended Notifier Responsibilities

- `main`
  - owns operator-facing release actions and manual notifier recovery
  - may call `release_notifications_drain` and can keep `pull/render/ack/fail/requeue` for debugging and backfill
  - may use `release_rollback` as a true one-click rollback path, because the tool now auto-approves by default
  - may use `release_build_status`, `release_stable_list`, `release_channel_history`, and `release_baselines` for release operations triage
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
