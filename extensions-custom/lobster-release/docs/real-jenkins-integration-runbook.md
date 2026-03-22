# Lobster Release Jenkins 联调 Runbook

## 1. 目标

本文档用于完成 `lobster-release` 与现有 `GameXpert_Godot_CI` Jenkins 流水线的第一次真实联调。

联调目标：

- `lobster-release` 主动触发 Jenkins `buildWithParameters`
- Jenkins 通过 `/api/ci/v1/builds/resolve-baseline`
- Jenkins 通过 `/api/ci/v1/builds/start`
- Jenkins 通过 `/api/ci/v1/builds/publish`
- Jenkins 通过 `/api/ci/v1/builds/finish`
- `lobster-release` 正确落库 release / build / artifact / provenance

## 2. 前置确认

当前仓库已经完成：

- `configs/openclaw.json` 已启用 `lobster-release`
- `configs/openclaw.json` 已加入插件目录加载路径
- `lobster-release` 已实现 Jenkins 触发参数映射
- `lobster-release` 已实现 `X-Lobster-*` HMAC 验签
- `lobster-release` 已兼容现有 Jenkins `requestId/jobName/buildNumber/git/app/baseline/artifacts/summary` 协议

## 3. 需要你提供的真实值

先准备这 5 个值：

- `PUBLIC_BASE_URL`
  - 例：`https://openclaw.example.com`
  - Jenkins 必须能访问到这个地址
- `CI_API_KEY`
  - 例：`lobster-ci-key`
- `CI_API_SECRET`
  - 建议 32 字节以上随机串
- `JENKINS_USER`
  - 例：`lobster-release`
- `JENKINS_API_TOKEN`

可选值：

- `JENKINS_BASE_URL`
  - 默认当前配置是 `http://127.0.0.1:8080`
- `JENKINS_JOB`
  - 默认当前配置是 `GameXpert_Godot_CI`

## 4. 写入 OpenClaw 配置

当前配置块位置：

- `configs/openclaw.json`

需要填写：

```json
"lobster-release": {
  "enabled": true,
  "config": {
    "defaultProjectKey": "gamexpert",
    "defaultEnvironment": "staging",
    "defaultChannel": "beta",
    "routePrefix": "/plugins/lobster-release/api",
    "ciRoutePrefix": "/api/ci/v1",
    "publicBaseUrl": "https://openclaw.example.com",
    "ciApiKey": "lobster-ci-key",
    "ciApiSecret": "replace-with-real-secret",
    "jenkinsBaseUrl": "http://127.0.0.1:8080",
    "jenkinsJob": "GameXpert_Godot_CI",
    "jenkinsUser": "lobster-release",
    "jenkinsApiToken": "replace-with-real-token",
    "jenkinsLobsterApiKeyCredentialsId": "lobster-api-key",
    "jenkinsLobsterApiSecretCredentialsId": "lobster-api-secret",
    "autoPublishDev": true
  }
}
```

注意：

- `publicBaseUrl` 不能留空，否则 `lobster-release` 不会触发 Jenkins
- `ciApiKey` / `ciApiSecret` 必须和 Jenkins Credentials 内的值一致
- `jenkinsLobsterApiKeyCredentialsId` / `jenkinsLobsterApiSecretCredentialsId` 必须和 Jenkins Job 中能取到的 Secret Text ID 一致

## 5. 在 Jenkins 创建 Credentials

需要创建两条 `Secret Text`：

1. `lobster-api-key`
   - 值：`CI_API_KEY`
2. `lobster-api-secret`
   - 值：`CI_API_SECRET`

如果 Jenkins 触发本身也需要认证，还需要保证：

- `jenkinsUser`
- `jenkinsApiToken`

能访问 `buildWithParameters`

## 6. 启动或重启 OpenClaw Gateway

推荐直接用仓库脚本对应的 repo config 启动：

```bash
pnpm start:server
```

等价命令：

```bash
OPENCLAW_CONFIG_PATH=configs/openclaw.json node scripts/run-node.mjs gateway --port 18789
```

如果 gateway 已经在跑，联调阶段建议重启一次再继续。

## 7. 启动后检查

先确认 gateway 正常启动：

```bash
OPENCLAW_CONFIG_PATH=configs/openclaw.json pnpm openclaw channels status
```

如果配置有问题，先跑：

```bash
OPENCLAW_CONFIG_PATH=configs/openclaw.json pnpm openclaw doctor
```

## 8. 第一次触发方式

建议用 `lobster-release` 自己的 HTTP API 创建 release，并让它主动触发 Jenkins。

请求：

```bash
curl -X POST http://127.0.0.1:18789/plugins/lobster-release/api/projects/gamexpert/releases \
  -H 'Content-Type: application/json' \
  -d '{
    "environment": "staging",
    "channel": "beta",
    "version": "1.2.3",
    "git": {
      "url": "git@github.com:wangpeng19820714-sketch/GameXpert_Godot.git",
      "branch": "main"
    },
    "targets": {
      "androidApk": true,
      "androidAab": false,
      "macosApp": false,
      "patch": true
    },
    "triggerBuild": true,
    "createdBy": "manual-smoke"
  }'
```

成功后应该看到：

- release 被创建
- build 被创建
- Jenkins Job 被触发

## 9. Jenkins 侧应该收到的参数

这次联调时，Jenkins 应该能拿到这些关键参数：

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
- `LOBSTER_API_KEY_CREDENTIALS_ID`
- `LOBSTER_API_SECRET_CREDENTIALS_ID`

特别注意：

- 当前实现不会主动下发 `PATCH_BASELINE_VERSION`
- baseline 应该由 Jenkins 在 `resolve-baseline` 阶段向 `lobster-release` 查询

## 10. 成功判定

联调成功至少满足这 6 条：

1. Jenkins 成功被 `lobster-release` 触发
2. Jenkins `resolve-baseline` 调用返回 `200`
3. Jenkins `start` 调用返回 `code: 0`
4. Jenkins `publish` 调用返回 `code: 0`
5. Jenkins `finish` 调用返回 `code: 0`
6. release 状态进入 `awaiting_approval` 或 `published`

## 11. 最小检查接口

可以用这些接口检查状态：

当前 release：

```bash
curl http://127.0.0.1:18789/plugins/lobster-release/api/projects/gamexpert/releases/<releaseId>
```

当前 channel 指针：

```bash
curl "http://127.0.0.1:18789/plugins/lobster-release/api/projects/gamexpert/channels/beta/current?environment=staging"
```

build provenance：

```bash
curl http://127.0.0.1:18789/plugins/lobster-release/api/projects/gamexpert/builds/<buildId>/provenance
```

## 12. 常见问题

### 12.1 Jenkins 没有被触发

先检查：

- `publicBaseUrl` 是否为空
- `jenkinsBaseUrl` / `jenkinsJob` 是否正确
- `jenkinsUser` / `jenkinsApiToken` 是否能调用 `buildWithParameters`

### 12.2 Jenkins 回调 403

先检查：

- `ciApiKey` 是否和 Jenkins `lobster-api-key` 一致
- `ciApiSecret` 是否和 Jenkins `lobster-api-secret` 一致
- Jenkins 的签名串是否仍然是：

```text
{HTTP_METHOD}\n
{REQUEST_PATH}\n
{X-Lobster-Timestamp}\n
{X-Lobster-Nonce}\n
{X-Lobster-Content-SHA256}
```

### 12.3 Patch baseline 不生效

先检查：

- Jenkins 是否真的调用了 `/api/ci/v1/builds/resolve-baseline`
- `BUILD_PATCH=true`
- `BUILD_TARGETS` 包含 `patch`
- `PATCH_BASELINE_VERSION` 没有被人工预填

## 13. 推荐执行顺序

1. 填 `configs/openclaw.json`
2. 在 Jenkins 创建 `lobster-api-key` / `lobster-api-secret`
3. 重启 gateway
4. 跑 `channels status`
5. 用 HTTP 创建第一条 release
6. 看 Jenkins 控制台确认参数
7. 看 Jenkins 控制台确认 4 次 Lobster 调用
8. 回查 release / channel / provenance
