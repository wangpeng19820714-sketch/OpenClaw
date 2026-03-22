# Release Manifest Schema

## 1. 目标

`release_manifest.json` 是发布中心、客户端、运营后台和回滚系统共同依赖的单一事实文件。

设计目标：

- 客户端只认一份 manifest
- 渠道切换和回滚优先通过 manifest 指针完成
- manifest 字段稳定、可版本化、可兼容演进

## 2. 文件位置

推荐路径：

```text
{project}/{environment}/{channel}/{version}/release_manifest.json
```

示例：

```text
gamexpert/production/release/1.2.3/release_manifest.json
```

## 3. Schema Version

第一版固定：

- `manifestVersion = 1`

规则：

- 客户端必须校验 `manifestVersion`
- 未来有破坏性字段变更时再升级到 `2`

## 4. 顶层结构

```json
{
  "manifestVersion": 1,
  "project": "gamexpert",
  "environment": "production",
  "channel": "release",
  "releaseId": "rel_20260322_001",
  "buildId": "bld_20260322_001",
  "version": "1.2.3",
  "displayVersion": "1.2.3",
  "status": "published",
  "stable": true,
  "frozen": false,
  "rollbackTarget": "rel_20260318_002",
  "publishedAt": "2026-03-22T10:20:00Z",
  "git": {
    "branch": "main",
    "commit": "8de107b1234567890",
    "commitShort": "8de107b",
    "tag": null
  },
  "provenance": {
    "hash": "prov_8f6d...",
    "jenkinsJob": "GameXpert_Godot_CI",
    "jenkinsBuildNumber": 42
  },
  "compatibility": {
    "minClientVersion": "1.2.0",
    "resourceProtocolVersion": 3,
    "minManifestVersion": 1
  },
  "baseline": {
    "releaseId": "rel_20260321_004",
    "version": "1.2.2",
    "manifestUrl": "https://cdn.example.com/gamexpert/production/release/1.2.2/release_manifest.json",
    "strategy": "reuse"
  },
  "artifacts": [
    {
      "type": "android_apk",
      "platform": "android",
      "fileName": "GameXpert-android-apk-1.2.3-42-8de107b.apk",
      "downloadUrl": "https://cdn.example.com/gamexpert/production/release/1.2.3/android/GameXpert-android-apk-1.2.3-42-8de107b.apk",
      "sha256": "abc123",
      "sizeBytes": 1048576
    }
  ],
  "patch": {
    "enabled": true,
    "manifestUrl": "https://cdn.example.com/gamexpert/production/release/1.2.3/patch/patch_manifest.json",
    "bundleUrl": "https://cdn.example.com/gamexpert/production/release/1.2.3/patch/GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
    "riskLevel": "medium"
  },
  "metadata": {
    "notes": "release candidate promoted after smoke pass"
  }
}
```

## 5. 字段定义

### 5.1 必填字段

- `manifestVersion`
- `project`
- `environment`
- `channel`
- `releaseId`
- `buildId`
- `version`
- `status`
- `stable`
- `frozen`
- `git`
- `provenance`
- `compatibility`
- `artifacts`

### 5.2 字段约束

- `environment`: `test | staging | production`
- `channel`: `dev | beta | release`
- `status`: 第一版只允许 `published`
- `artifacts`: 至少 1 个
- `rollbackTarget`: 可为空，但生产环境建议总是带上最近稳定版本

## 6. Artifact 结构

每个 artifact 对象：

```json
{
  "type": "patch_bundle",
  "platform": "patch",
  "fileName": "GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
  "downloadUrl": "https://cdn.example.com/gamexpert/production/release/1.2.3/patch/GameXpert-patch-bundle-1.2.3-42-8de107b.zip",
  "sha256": "def456",
  "sizeBytes": 2048000,
  "manifestRole": "patch_bundle"
}
```

第一版支持的 `type`：

- `android_apk`
- `android_aab`
- `macos_zip`
- `patch_bundle`
- `patch_manifest`
- `patch_list`
- `build_report`
- `bundle_layout`

## 7. Compatibility 规则

`compatibility` 必须用于客户端守门。

```json
{
  "minClientVersion": "1.2.0",
  "resourceProtocolVersion": 3,
  "minManifestVersion": 1
}
```

规则：

- 客户端版本 `< minClientVersion` 时不得应用该 release
- 客户端资源协议版本不匹配时不得加载 patch
- 客户端不认识的 `manifestVersion` 必须拒绝并上报

## 8. Baseline 规则

当 release 包含 patch 时，必须包含 `baseline`。

当 release 不包含 patch 时：

- `baseline` 可为空

当 `patch.enabled = true` 时，以下字段必填：

- `baseline.releaseId`
- `baseline.version`
- `baseline.manifestUrl`
- `baseline.strategy`

`baseline.strategy` 只允许：

- `reuse`
- `validate`
- `reset`

## 9. Patch 规则

当 release 含 patch：

```json
{
  "enabled": true,
  "manifestUrl": "https://cdn.example.com/.../patch_manifest.json",
  "bundleUrl": "https://cdn.example.com/.../patch_bundle.zip",
  "riskLevel": "medium"
}
```

`riskLevel`：

- `low`
- `medium`
- `high`

规则：

- `patch.enabled = true` 时必须存在 `patch_manifest` artifact
- `patch.enabled = true` 时必须存在 `patch_bundle` artifact
- `patch.enabled = true` 时建议存在 `patch_list` 和 `build_report`

## 10. 产物不可变规则

- 一旦 manifest 对外发布，其引用的 artifact URL 不得原地覆盖
- rebuild 必须生成新的 `buildId` 和新的 artifact 路径
- manifest 可以更新为新版本，但旧版本 manifest 和旧 artifact 必须保留

## 11. 回滚规则

- `rollbackTarget` 建议始终指向最近稳定 release
- rollback 成功后，当前渠道指针切到目标 release 的 manifest
- 回滚不修改历史 release manifest 内容，只切渠道当前指针

## 12. 最小校验清单

发布中心在生成 manifest 时必须校验：

1. 顶层必填字段完整
2. `manifestVersion` 合法
3. `artifacts` 至少包含一个主产物
4. 每个 artifact 都有 `downloadUrl`、`sha256`、`sizeBytes`
5. patch release 的 baseline 和 patch 字段完整
6. compatibility 字段存在
7. provenance hash 存在

## 13. 建议的 JSON Schema 约束

实现时建议转成正式 JSON Schema，至少包含：

- `type: object`
- `additionalProperties: false`
- 顶层 `required`
- `environment` / `channel` / `riskLevel` / `type` 枚举约束

## 14. 实现建议

推荐实现顺序：

1. 先在服务端内部用 TypeScript 类型定义
2. 再导出 JSON Schema
3. 发布前对生成结果跑 schema 校验
4. Jenkins `publish` 回传后再生成最终 manifest
