# Versioning Governance

## 1. 目标

这份文档定义 `lobster-release` 如何维护版本号，而不是把版本号当成一个随便输入的字符串。

目标：

- 统一团队口径
- 阻止错误版本覆盖
- 为 patch baseline 和回滚提供可靠依据

## 2. 第一版版本格式

第一版固定使用：

```text
major.minor.patch
```

示例：

- `1.2.3`

第一版默认不支持：

- `1.2.3-beta.1`
- `2026.03.22`
- 四段版本号

## 3. 中文定义

### 3.1 `major`

中文含义：

- 主版本
- 大版本
- 破坏性版本

适用：

- 协议变更
- 资源结构大改
- 热更新规则变化
- 客户端存档不兼容
- 需要整体重置 baseline

### 3.2 `minor`

中文含义：

- 次版本
- 功能版本
- 小版本

适用：

- 新功能
- 新内容
- 新资源包
- 模块增强

默认前提：

- 整体兼容关系不被破坏

### 3.3 `patch`

中文含义：

- 补丁版本
- 热修复版本
- 修订版本

适用：

- bugfix
- 小资源修正
- 脚本修补
- 配置修复

默认前提：

- 不改大结构

## 4. 基本规则

### 4.1 版本比较

同一 `project + environment + channel` 内：

- 新版本必须严格大于当前版本

拒绝：

- 相同版本重复覆盖
- 低版本覆盖高版本

### 4.2 rebuild 规则

允许 rebuild，但规则是：

- `release` 可以复用
- `buildId` 必须新建
- artifact 路径必须新建
- graph 里写一条 `rebuilt_from` 关系

### 4.3 版本来源

第一版支持：

- `manual`
- `suggested`
- `enforced`

推荐默认：

- `manual + validate`

## 5. Bump 类型判定

输入：

- 当前版本
- 目标版本

输出：

- `patch`
- `minor`
- `major`

示例：

- `1.2.3 -> 1.2.4` = `patch`
- `1.2.3 -> 1.3.0` = `minor`
- `1.2.3 -> 2.0.0` = `major`

非法示例：

- `1.2.3 -> 1.2.3`
- `1.2.3 -> 1.2.2`
- `1.2.3 -> 1.3.1`

第一版建议只接受“标准 bump”，不接受跳跃式混合变更。

## 6. 与 Baseline 的联动

### 6.1 `patch`

默认：

- 优先复用最近稳定 baseline

### 6.2 `minor`

默认：

- 允许复用 baseline
- 但必须通过 compatibility 校验

### 6.3 `major`

默认：

- 不复用旧 baseline
- baseline 策略走 `reset`

## 7. 与渠道的联动

### 7.1 `dev`

建议：

- 允许 `patch` / `minor` / `major`
- 可以配置自动发布

### 7.2 `beta`

建议：

- 允许 `patch` / `minor` / `major`
- 默认进入待审批

### 7.3 `release`

建议：

- 允许 `patch` / `minor` / `major`
- 必须人工审批

## 8. 推荐配置结构

```json
{
  "versioning": {
    "scheme": "semver3",
    "defaultMode": "manual",
    "allowPrerelease": false,
    "channelPolicies": {
      "dev": {
        "allowAutoPublish": true,
        "allowBumpTypes": ["patch", "minor", "major"]
      },
      "beta": {
        "allowAutoPublish": false,
        "allowBumpTypes": ["patch", "minor", "major"]
      },
      "release": {
        "allowAutoPublish": false,
        "requireApproval": true,
        "allowBumpTypes": ["patch", "minor", "major"]
      }
    },
    "baselinePolicies": {
      "patch": "reuse",
      "minor": "validate",
      "major": "reset"
    }
  }
}
```

## 9. 版本建议规则

### 9.1 `suggest patch`

当前版本：

- `1.2.3`

建议：

- `1.2.4`

### 9.2 `suggest minor`

当前版本：

- `1.2.3`

建议：

- `1.3.0`

### 9.3 `suggest major`

当前版本：

- `1.2.3`

建议：

- `2.0.0`

## 10. 人工覆盖边界

这些情况允许人工说明后继续：

- 同一版本号 rebuild
- 紧急回滚后重新打修复包
- 从旧分支补发历史热修复

但即便人工覆盖，也不应绕过：

- compatibility 校验
- artifact 不可变规则
- rollback 审计记录

## 11. 实现建议

第一版：

1. 解析 `major.minor.patch`
2. 计算 bump type
3. 拒绝重复和回退
4. 联动 baseline 策略

第二版：

1. 支持 prerelease
2. 支持 tag 驱动版本建议
3. 支持按 PR label 自动建议 bump type
