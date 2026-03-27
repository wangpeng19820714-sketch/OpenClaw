# 故障排查

## 1. Jenkins 构建卡住不执行

典型表现：

- Jenkins 一直排队
- 控制台显示 `Still waiting to schedule task`
- 节点显示 `offline`

优先检查：

- `local-macos` 或目标 agent 是否在线
- Jenkins Job 的 label 是否匹配当前可用节点

## 2. `resolve-baseline` 返回 403

优先检查：

- Jenkins `Secret text` 的 key/secret 是否和 `.env` 一致
- 是否存在前后空格或换行
- `X-Lobster-*` 签名是否按约定生成

## 3. `publish` 失败但构建成功

优先检查：

- `uploaded_artifacts.json` 是否只包含当前 build 产物
- 产物文件名是否包含正确 `version-buildNumber`
- 必需 artifact 是否齐全
- patch 构建时是否同时有：
  - `patch_manifest`
  - `patch_bundle`

如果 smoke gate 拦截，通常会直接看到：

- `required artifact missing: ...`

## 4. patch 构建被拒绝

优先检查：

- `patch_manifest.json` schema 是否符合已支持格式
- `patch_list.json` 是否有归一化后重复路径
- baseline manifest URL 是否存在
- `resourceProtocolVersion` 是否与 release compatibility 一致

## 5. release 已完成但没进入 published

优先检查：

- 是否还在 `awaiting_approval`
- 是否是 `beta` / `release` 渠道
- 是否需要手动执行 `release_approve`

## 6. notifier 没发出去

优先检查：

- `notification_outbox` 状态是否是 `pending / sending / failed`
- `pm` 是否具备：
  - `message`
  - `release_notifications_pull`
  - `release_notifications_render`
  - `release_notifications_ack`
  - `release_notifications_fail`
- `notifierSessionKey` 是否正确指向 `agent:pm:main`

如果通知卡在 `sending`，下一次 `pull` 会自动回收超时记录。

## 7. rollback 被拒绝

优先检查：

- 目标 release 是否 stable
- 是否与当前 release 属于同一 project/environment
- `minClientVersion` 是否回退
- `resourceProtocolVersion` 是否不兼容

若兼容性不通过，会直接返回：

- `rollback.compatibility_conflict`

## 8. 重复 callback 导致状态异常

当前已做保护：

- nonce 防重放
- idempotency receipt 复用
- terminal build status 不回退

如果还看到异常状态，应优先检查：

- 上游是否复用了相同 idempotency key 但 body 不同
- 是否存在人工回放了旧请求
