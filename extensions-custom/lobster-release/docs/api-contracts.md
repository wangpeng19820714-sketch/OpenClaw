# Lobster Release API Contracts

## 1. Scope

This document defines the first implementation contract for:

- release creation and trigger
- rollout routing and gray control
- release graph
- build provenance
- maintenance and retention
- patch baseline resolution
- Jenkins callbacks
- rollback

Base path:

```text
/api
```

## 2. Common Rules

### 2.1 Headers

Client to `lobster-release`:

```http
Content-Type: application/json
X-Request-Id: req_20260322_001
X-Idempotency-Key: gamexpert:beta:1.2.3:create
Authorization: Bearer <token>
```

Jenkins callback to `lobster-release`:

```http
Content-Type: application/json
X-Request-Id: req_20260322_002
X-Idempotency-Key: gamexpert:42:publish
X-Timestamp: 1711111111
X-Nonce: 0f2a8d
X-Signature: sha256=<hmac>
```

### 2.2 Success Envelope

```json
{
  "ok": true,
  "data": {}
}
```

### 2.3 Error Envelope

```json
{
  "ok": false,
  "error": {
    "code": "release.version_conflict",
    "message": "version 1.2.3 is not greater than current beta release 1.2.3",
    "details": {}
  }
}
```

### 2.4 Suggested Error Codes

- `auth.invalid_signature`
- `auth.timestamp_expired`
- `request.invalid`
- `request.conflict`
- `request.idempotency_conflict`
- `release.not_found`
- `release.version_conflict`
- `release.channel_locked`
- `build.not_found`
- `build.invalid_status`
- `rollback.not_found`
- `rollback.invalid_target`
- `rollback.lock_conflict`
- `rollout.not_found`
- `rollout.scope_conflict`
- `rollout.in_progress`
- `artifact.invalid_sha256`
- `baseline.not_found`

## 3. Release APIs

### 3.1 Create Release

`POST /api/projects/:projectKey/releases`

Request:

```json
{
  "environment": "staging",
  "channel": "beta",
  "version": "1.2.3",
  "git": {
    "url": "git@github.com:example/GameXpert_Godot.git",
    "branch": "main",
    "commit": "8de107b1234567890"
  },
  "targets": {
    "androidApk": true,
    "androidAab": false,
    "macosApp": true,
    "patch": true
  },
  "notes": "beta candidate for weekend test",
  "triggerBuild": false
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "releaseId": "rel_20260322_001",
    "status": "draft",
    "versionBumpType": "patch"
  }
}
```

### 3.2 Trigger Release Build

`POST /api/projects/:projectKey/releases/:releaseId/trigger`

Request:

```json
{
  "rebuild": false,
  "operator": "pengwang"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "releaseId": "rel_20260322_001",
    "buildId": "bld_20260322_001",
    "status": "building",
    "jenkinsJob": "GameXpert_Godot_CI",
    "jenkinsQueueId": "41231"
  }
}
```

### 3.3 Get Release

`GET /api/projects/:projectKey/releases/:releaseId`

Response:

```json
{
  "ok": true,
  "data": {
    "releaseId": "rel_20260322_001",
    "environment": "staging",
    "channel": "beta",
    "version": "1.2.3",
    "status": "published",
    "stable": true,
    "frozen": false
  }
}
```

### 3.4 Get Current Channel State

`GET /api/projects/:projectKey/channels/:channel/current?environment=staging`

Response:

```json
{
  "ok": true,
  "data": {
    "channel": "beta",
    "environment": "staging",
    "currentReleaseId": "rel_20260322_001",
    "previousReleaseId": "rel_20260321_004"
  }
}
```

## 4. Release Graph APIs

### 4.1 Release Graph

`GET /api/projects/:projectKey/releases/:releaseId/graph?direction=both&depth=3`

Response:

```json
{
  "ok": true,
  "data": {
    "releaseId": "rel_20260322_001",
    "nodes": [
      {
        "releaseId": "rel_20260321_004",
        "version": "1.2.2",
        "channel": "beta",
        "status": "published"
      },
      {
        "releaseId": "rel_20260322_001",
        "version": "1.2.3",
        "channel": "beta",
        "status": "published"
      }
    ],
    "edges": [
      {
        "relationId": "reln_001",
        "relationType": "derived_from",
        "fromReleaseId": "rel_20260321_004",
        "toReleaseId": "rel_20260322_001"
      }
    ]
  }
}
```

### 4.2 Channel Graph

`GET /api/projects/:projectKey/channels/:channel/graph?environment=production&depth=10`

## 4A. Rollout APIs

### 4A.1 Create Rollout

`POST /api/projects/:projectKey/channels/:channel/rollouts`

Request:

```json
{
  "environment": "production",
  "releaseId": "rel_20260327_001",
  "trafficPercent": 10,
  "scope": {
    "region": "cn",
    "audience": "internal"
  },
  "notes": "first canary"
}
```

Response highlights:

- `rolloutId`
- `status = active`
- `trafficPercent`
- `scope`

### 4A.2 List Rollouts

`GET /api/projects/:projectKey/channels/:channel/rollouts?environment=production`

Response highlights:

- rollout records ordered by latest update
- `releaseId`
- `status`
- `trafficPercent`
- `scope.region`
- `scope.audience`

### 4A.3 Advance Rollout

`POST /api/projects/:projectKey/rollouts/:rolloutId/advance`

Request:

```json
{
  "trafficPercent": 50,
  "complete": false,
  "publishRelease": false,
  "operator": "pengwang"
}
```

Notes:

- `trafficPercent = 100` or `complete = true` marks the rollout completed
- `publishRelease = true` publishes the rollout release and moves the channel pointer after completion

### 4A.4 Cancel Rollout

`POST /api/projects/:projectKey/rollouts/:rolloutId/cancel`

Request:

```json
{
  "reason": "bad crash metrics",
  "operator": "pengwang"
}
```

### 4A.5 Resolve Channel Route

`GET /api/projects/:projectKey/channels/:channel/route?environment=production&region=cn&audience=internal&bucket=7`

Response highlights:

- `route = rollout | channel`
- `bucket`
- `selectedRelease`
- `selectedManifestUrl`
- `fallbackRelease`
- `activeRollouts[]`

## 5. Build Provenance APIs

### 5.1 Build Provenance

`GET /api/projects/:projectKey/builds/:buildId/provenance`

Response highlights:

- `sourceGit*`
- `jenkinsJob`
- `jenkinsBuildNumber`
- `baselineVersion`
- `baselineManifestUrl`
- optional archived CI environment fields:
  - `godotVersion`
  - `godotBin`
  - `dotnetVersion`
  - `exportPresets`
  - `workspaceRevision`
  - `configFingerprint`
  - `assetGroupsFingerprint`
  - `scriptsFingerprint`
  - `envSnapshot.configVersion`
  - `envSnapshot.scriptVersions`

## 6. Maintenance APIs

### 6.1 Store Status

`GET /api/projects/:projectKey/store/status`

Response:

```json
{
  "ok": true,
  "data": {
    "schema": {
      "metaKey": "store_schema_version",
      "schemaVersion": 1
    },
    "counts": {
      "releases": 42,
      "builds": 45,
      "notifications": 8,
      "failedNotifications": 1,
      "stableReleases": 18
    },
    "retention": {
      "artifactRetentionDays": 21,
      "auditRetentionDays": 30,
      "maintenanceKeepStableCount": 10
    }
  }
}
```

### 6.2 Run Maintenance

`POST /api/projects/:projectKey/maintenance/run`

Request:

```json
{
  "dryRun": true
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "projectKey": "gamexpert",
    "dryRun": true,
    "artifactCleanup": {
      "candidateReleaseIds": ["rel_20260322_001"],
      "candidateBuildIds": ["bld_20260322_001"],
      "candidateArtifactIds": ["art_20260322_001"],
      "manifestReleaseIds": ["rel_20260322_001"]
    },
    "auditCleanup": {
      "deletedEvents": 0,
      "deletedNotifications": 0,
      "deletedIdempotencyReceipts": 0
    }
  }
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "buildId": "bld_20260322_001",
    "releaseId": "rel_20260322_001",
    "git": {
      "url": "git@github.com:example/GameXpert_Godot.git",
      "branch": "main",
      "commit": "8de107b1234567890",
      "tag": null
    },
    "jenkins": {
      "job": "GameXpert_Godot_CI",
      "buildNumber": 42,
      "queueId": "41231",
      "node": "local-macos"
    },
    "toolchain": {
      "godotVersion": "4.6.1 mono",
      "dotnetVersion": "8.0.0"
    },
    "baseline": {
      "version": "1.2.2",
      "manifestUrl": "https://cdn.example.com/release/1.2.2/release_manifest.json"
    },
    "provenanceHash": "prov_8f6d..."
  }
}
```

### 5.2 Release Provenance

`GET /api/projects/:projectKey/releases/:releaseId/provenance?mode=latest`

Supported `mode`:

- `latest`
- `all`

## 6. Baseline API

### 6.1 Resolve Baseline

`GET /api/projects/:projectKey/baselines/resolve?environment=staging&channel=beta&platform=patch&targetVersion=1.2.3&gitCommit=8de107b`

Response:

```json
{
  "ok": true,
  "data": {
    "baselineReleaseId": "rel_20260321_004",
    "baselineVersion": "1.2.2",
    "baselineManifestUrl": "https://cdn.example.com/release/1.2.2/release_manifest.json",
    "patchStrategy": "reuse"
  }
}
```

## 7. Jenkins Callback APIs

### 7.1 Build Start

`POST /api/projects/:projectKey/builds/:buildId/start`

Request:

```json
{
  "jenkinsJob": "GameXpert_Godot_CI",
  "jenkinsBuildNumber": 42,
  "jenkinsQueueId": "41231",
  "executorNode": "local-macos",
  "executorLabel": "macos",
  "startedAt": "2026-03-22T10:00:00Z"
}
```

### 7.2 Publish Artifacts

`POST /api/projects/:projectKey/builds/:buildId/publish`

Request:

```json
{
  "environment": "staging",
  "channel": "beta",
  "artifacts": [
    {
      "artifactType": "android_apk",
      "platform": "android",
      "fileName": "GameXpert-android-apk-1.2.3-42-8de107b.apk",
      "fileSizeBytes": 1048576,
      "sha256": "abc123",
      "storageProvider": "s3",
      "storagePath": "gamexpert/staging/beta/1.2.3/android/GameXpert-android-apk-1.2.3-42-8de107b.apk",
      "downloadUrl": "https://cdn.example.com/gamexpert/staging/beta/1.2.3/android/GameXpert-android-apk-1.2.3-42-8de107b.apk"
    }
  ]
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "buildId": "bld_20260322_001",
    "artifactCount": 1,
    "releaseManifestUrl": "https://cdn.example.com/gamexpert/staging/beta/1.2.3/release_manifest.json"
  }
}
```

### 7.3 Build Finish

`POST /api/projects/:projectKey/builds/:buildId/finish`

Request:

```json
{
  "status": "success",
  "summary": "android_apk + macos_app + patch completed",
  "durationSeconds": 684,
  "reports": {
    "buildReportUrl": "https://cdn.example.com/reports/build_report.json"
  },
  "artifactsCount": 6,
  "error": null
}
```

## 8. Rollback APIs

### 8.1 Create Rollback

`POST /api/projects/:projectKey/channels/:channel/rollback`

Request:

```json
{
  "environment": "production",
  "targetReleaseId": "rel_20260318_002",
  "reason": "production crash after patch publish",
  "strategy": "pointer_switch",
  "freezeCurrentRelease": true,
  "comment": "rollback after hotupdate loading failure"
}
```

Response:

```json
{
  "ok": true,
  "data": {
    "rollbackId": "rbk_20260322_001",
    "fromReleaseId": "rel_20260322_001",
    "toReleaseId": "rel_20260318_002",
    "status": "requested",
    "strategy": "pointer_switch"
  }
}
```

### 8.2 Get Rollback

`GET /api/projects/:projectKey/rollbacks/:rollbackId`

### 8.3 Approve Rollback

`POST /api/projects/:projectKey/rollbacks/:rollbackId/approve`

Request:

```json
{
  "approver": "ops_lead",
  "comment": "approved for immediate recovery"
}
```

### 8.4 Cancel Rollback

`POST /api/projects/:projectKey/rollbacks/:rollbackId/cancel`

### 8.5 Rollback Result Shape

```json
{
  "ok": true,
  "data": {
    "rollbackId": "rbk_20260322_001",
    "status": "completed",
    "channelBefore": {
      "environment": "production",
      "channel": "release",
      "currentReleaseId": "rel_20260322_001"
    },
    "channelAfter": {
      "environment": "production",
      "channel": "release",
      "currentReleaseId": "rel_20260318_002"
    },
    "frozenReleaseId": "rel_20260322_001",
    "relationEdgeId": "reln_rollback_001",
    "manifestUrl": "https://cdn.example.com/gamexpert/production/release/current/release_manifest.json",
    "warnings": []
  }
}
```
