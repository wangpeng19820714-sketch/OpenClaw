# Rollback And Compatibility

## 1. 目标

这份文档定义两类守门规则：

- 回滚规则
- 客户端兼容性规则

这两部分必须一起看，因为很多回滚事故不是“能不能切回去”，而是“切回去后客户端还能不能正常加载”。

## 2. Rollback 定义

rollback 的业务含义：

- 把某个 `environment + channel` 从当前 release 恢复到一个已知稳定 release

rollback 默认不是重新构建，而是恢复发布指针。

## 3. Rollback 策略

第一版支持 3 种策略：

### 3.1 `pointer_switch`

中文含义：

- 指针切换

做法：

- 直接把 `release_channel_state.current_release_id` 指向目标 release
- 当前渠道的“current manifest”重新指到目标 release manifest

优点：

- 最快
- 风险最低
- 不依赖重新构建

默认优先级：

- 第一优先

### 3.2 `manifest_republish`

中文含义：

- 重新发布 manifest

做法：

- 重新生成一个“当前渠道 manifest”
- 但其中 artifact 指向旧 release 的稳定产物

适用：

- CDN 或客户端依赖固定 current manifest 路径

### 3.3 `rebuild_and_publish`

中文含义：

- 重新构建并发布

适用：

- 旧产物丢失
- 旧 manifest 不完整
- 旧资源和当前兼容策略不满足

默认规则：

- 非必要不使用

## 4. Rollback 状态流

`rollback_operation.status`：

1. `requested`
2. `approved`
3. `executing`
4. `completed`

异常状态：

- `failed`
- `canceled`

## 5. Rollback 前置校验

发起 rollback 前必须检查：

1. 目标 release 属于同一 `project`
2. 目标 release 属于同一 `environment`
3. 目标 release 允许被回滚到当前 channel
4. 目标 release 标记为 `stable=true` 或被显式允许
5. 目标 release 未被冻结为不可回退目标
6. 目标 release 的主 artifact 仍可下载
7. 目标 release 的 `release_manifest.json` 完整可用
8. 当前 channel 未被其他操作锁占用

## 6. Rollback 成功后的强制动作

rollback 成功后应自动执行：

1. 更新 `release_channel_state`
2. 记录 `rollback_operation`
3. 写入 `release_relation` 边：`rolled_back_to`
4. 冻结事故版本
5. 发送通知
6. 记录审计事件

## 7. 事故版本冻结规则

当 rollback 由线上事故触发时，默认：

- `freezeCurrentRelease = true`

冻结后的 release：

- 不允许再次 promote
- 不允许再次作为默认 rollback target
- 必须人工解冻后才能恢复流转

## 8. 客户端兼容性模型

发布中心必须维护以下兼容性信息：

### 8.1 客户端版本兼容

- `minClientVersion`

含义：

- 低于这个客户端版本的设备不能应用该 release

### 8.2 资源协议兼容

- `resourceProtocolVersion`

含义：

- 客户端热更加载器和 patch 资源结构必须匹配

### 8.3 Manifest 兼容

- `minManifestVersion`

含义：

- 客户端至少要能识别该 manifest schema 版本

## 9. 兼容性校验点

### 9.1 发布前校验

发布中心在 approve/publish 前校验：

- `release_manifest.json` 包含 compatibility 信息
- patch baseline 与当前 compatibility 规则不冲突
- 如果 `resourceProtocolVersion` 变化，必须标记高风险

### 9.2 客户端拉取时校验

客户端在应用前校验：

- 自身版本 >= `minClientVersion`
- 自身协议版本 == `resourceProtocolVersion`
- 自身可识别 manifest version

### 9.3 Rollback 前校验

回滚到旧版本前还要额外检查：

- 旧 release 的 compatibility 是否仍然允许当前在线客户端使用
- 如果线上客户端已经大规模升级协议版本，不能盲目回滚到老协议 release

## 10. 高风险场景

这些情况必须判定为高风险：

1. `resourceProtocolVersion` 变化
2. patch baseline 改成 `reset`
3. `major` 版本升级
4. rollback 目标 release 的 compatibility 与当前线上客户端不匹配
5. 目标 release artifact 不完整但仍尝试回滚

高风险规则：

- 必须人工审批
- 必须发通知
- 建议附带 smoke 结果

## 11. 推荐 API 行为

### 11.1 回滚请求失败时

返回：

- `rollback.invalid_target`
- `rollback.lock_conflict`
- `rollback.compatibility_conflict`

### 11.2 发布审批失败时

返回：

- `release.compatibility_conflict`
- `release.patch_risk_too_high`

## 12. 推荐告警文案

### 12.1 兼容性阻断

```text
Release 1.2.3 is blocked.
Reason: resource protocol version changed from 2 to 3.
Action: manual approval and smoke verification required.
```

### 12.2 回滚阻断

```text
Rollback blocked.
Target release 1.2.1 is not compatible with current production clients.
Action: choose a newer stable release or rebuild with compatible manifest.
```

## 13. 实现建议

第一版先做：

1. `pointer_switch` rollback
2. `minClientVersion` 校验
3. `resourceProtocolVersion` 校验
4. 高风险 patch 阻断

当前实现状态：

- 已支持 `pointer_switch`
- rollback 时会重写目标 release 的 `release_manifest.json`
- source release 会标记为 `rolled_back`
- `freezeCurrentRelease=true` 时会冻结事故版本
- 当前兼容性阻断规则：
  - `target.minClientVersion < current.minClientVersion` 时阻断
  - `target.resourceProtocolVersion != current.resourceProtocolVersion` 时阻断

第二版再补：

1. `manifest_republish`
2. 更细的客户端分群兼容
3. 自动兼容性分析
