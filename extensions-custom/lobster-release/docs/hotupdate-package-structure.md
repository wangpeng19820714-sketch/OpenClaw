# Hotupdate Package Structure

## 1. Goals

Hotupdate packaging should make these questions easy to answer:

- this patch is based on which release
- this patch contains which bundles and manifests
- this patch is compatible with which client range
- this patch can be rolled back to which stable release

## 2. Release-Level Layout

Recommended release storage layout:

```text
gamexpert/
  staging/
    beta/
      1.2.3/
        release_manifest.json
        android/
          GameXpert-android-apk-1.2.3-42-8de107b.apk
          GameXpert-android-apk-1.2.3-42-8de107b.apk.sha256
        macos/
          GameXpert-macos-app-1.2.3-42-8de107b.zip
          GameXpert-macos-app-1.2.3-42-8de107b.zip.sha256
        patch/
          GameXpert-patch-bundle-1.2.3-42-8de107b.zip
          patch_manifest.json
          patch_list.json
          build_report.json
          bundle_layout.json
```

## 3. Patch Bundle Zip Layout

Recommended zip internal structure:

```text
GameXpert-patch-bundle-1.2.3-42-8de107b.zip
  metadata/
    patch_manifest.json
    patch_list.json
    build_report.json
    bundle_layout.json
  bundles/
    base/
      ui.bundle
      audio.bundle
    hotfix/
      Hotfix.dll
  hashes/
    bundles.sha256
```

## 4. Required Files

### 4.1 `patch_manifest.json`

Required responsibilities:

- declare release id and baseline release id
- declare compatibility window
- declare patch bundle identity
- declare client loading contract version

Suggested shape:

```json
{
  "manifestVersion": 1,
  "project": "gamexpert",
  "environment": "staging",
  "channel": "beta",
  "releaseId": "rel_20260322_001",
  "buildId": "bld_20260322_001",
  "version": "1.2.3",
  "baseline": {
    "releaseId": "rel_20260321_004",
    "version": "1.2.2",
    "manifestUrl": "https://cdn.example.com/release/1.2.2/release_manifest.json"
  },
  "compatibility": {
    "minClientVersion": "1.2.0",
    "resourceProtocolVersion": 3
  },
  "bundleZip": {
    "fileName": "GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
    "sha256": "abc123"
  }
}
```

### 4.2 `patch_list.json`

Purpose:

- enumerate changed files or bundles
- support patch risk evaluation

Suggested shape:

```json
{
  "releaseId": "rel_20260322_001",
  "items": [
    {
      "path": "bundles/base/ui.bundle",
      "op": "replace",
      "sha256": "abc123"
    }
  ]
}
```

### 4.3 `build_report.json`

Purpose:

- summarize patch build result
- keep diagnostics for provenance and support

Suggested shape:

```json
{
  "buildId": "bld_20260322_001",
  "status": "success",
  "godotVersion": "4.6.1 mono",
  "buildTargets": ["patch"],
  "warnings": [],
  "generatedAt": "2026-03-22T10:12:00Z"
}
```

### 4.4 `bundle_layout.json`

Purpose:

- describe logical bundle groups
- help agent and tooling explain what changed

## 5. Release Manifest

Recommended `release_manifest.json` shape:

```json
{
  "manifestVersion": 1,
  "project": "gamexpert",
  "environment": "staging",
  "channel": "beta",
  "releaseId": "rel_20260322_001",
  "version": "1.2.3",
  "stable": true,
  "rollbackTarget": "rel_20260321_004",
  "provenanceHash": "prov_8f6d...",
  "compatibility": {
    "minClientVersion": "1.2.0",
    "resourceProtocolVersion": 3
  },
  "artifacts": [
    {
      "type": "android_apk",
      "platform": "android",
      "downloadUrl": "https://cdn.example.com/gamexpert/staging/beta/1.2.3/android/GameXpert-android-apk-1.2.3-42-8de107b.apk",
      "sha256": "abc123"
    },
    {
      "type": "patch_bundle",
      "platform": "patch",
      "downloadUrl": "https://cdn.example.com/gamexpert/staging/beta/1.2.3/patch/GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
      "sha256": "def456"
    }
  ]
}
```

## 6. Validation Rules

- patch bundle must reference exactly one baseline release
- patch bundle must include `patch_manifest.json`
- release manifest must include `manifestVersion`
- release manifest must include `compatibility`
- all published artifacts must have `sha256`
- bundle zip path must be immutable once published

## 7. Risk Levels

Recommended patch risk classification:

- `low`
  only script/config hotfix, no compatibility change
- `medium`
  resource bundle replacement, same protocol version
- `high`
  resource protocol change or client compatibility window change

High risk patches should require manual approval before `release` promotion.
