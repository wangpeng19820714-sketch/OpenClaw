# Jenkins 集成说明

## 1. 集成边界

当前架构是：

- `lobster-release` 负责创建 release、触发 Jenkins、接收回调、管理 manifest、审批、rollback
- Jenkins 只负责执行构建、上传产物、回传结果

不推荐让 Jenkins 自己创建 release 或直接决定渠道状态。

## 2. 触发方式

当前使用：

- `buildWithParameters`

由 `lobster-release -> Jenkins` 主动触发。

## 3. 当前已对齐的参数

核心参数包括：

- `GIT_URL`
- `GIT_BRANCH`
- `GIT_COMMIT`
- `BUILD_ANDROID_APK`
- `BUILD_ANDROID_AAB`
- `BUILD_MACOS_APP`
- `BUILD_PATCH`
- `BUILD_TARGETS`
- `APP_VERSION`
- `RESOURCE_VERSION`
- `RELEASE_ID`
- `BUILD_ID`
- `LOBSTER_RESOLVE_BASELINE`
- `LOBSTER_NOTIFY_BUILD_START`
- `LOBSTER_NOTIFY_PUBLISH`
- `LOBSTER_NOTIFY_BUILD_FINISH`
- `LOBSTER_API_BASE_URL`
- `LOBSTER_CHANNEL`
- `LOBSTER_PLATFORM`
- `LOBSTER_ENDPOINT_RESOLVE_BASELINE`
- `LOBSTER_ENDPOINT_BUILD_START`
- `LOBSTER_ENDPOINT_PUBLISH`
- `LOBSTER_ENDPOINT_FINISH`

## 4. 当前回调路径

Jenkins 当前使用两类回调：

### 4.1 CI 统一接口

- `POST /api/ci/v1/builds/resolve-baseline`
- `POST /api/ci/v1/builds/start`
- `POST /api/ci/v1/builds/publish`
- `POST /api/ci/v1/builds/finish`

### 4.2 已签名的 release/build 定向接口

- `POST /projects/:projectKey/builds/:buildId/start`
- `POST /projects/:projectKey/builds/:buildId/publish`
- `POST /projects/:projectKey/builds/:buildId/finish`

## 5. 当前安全策略

- HMAC 校验
- `timestamp` 校验
- `nonce` 防重放
- `idempotency-key` 幂等
- callback 最小限流
- retryable 失败返回 `Retry-After`

## 6. 可选 provenance 扩展

Jenkins 如果愿意补充构建环境快照，可以在 `start / publish / finish` 回调里附带：

- `environmentInfo.godotVersion`
- `environmentInfo.godotBin`
- `environmentInfo.dotnetVersion`
- `environmentInfo.exportPresets`
- `environmentInfo.workspaceRevision`
- `environmentInfo.configFingerprint`
- `environmentInfo.assetGroupsFingerprint`
- `environmentInfo.scriptsFingerprint`
- `environmentInfo.configVersion`
- `environmentInfo.scriptVersions`

这些字段不会影响回调主流程，但会被归档进 build provenance，方便后续排查“同版本不同机器为什么产物不同”。

## 7. 当前联调结果

已经真实验证通过：

- Android APK + patch
- Android AAB
- macOS app
- failed build callback
- duplicate callback idempotency
- patch conflict rejection

配合文档：

- `jenkins-templates.md`
- `real-jenkins-integration-runbook.md`

可以直接用于现有 `GameXpert_Godot_CI`。
