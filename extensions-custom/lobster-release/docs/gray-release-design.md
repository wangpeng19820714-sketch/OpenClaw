# 灰度发布设计

## 1. 目标

灰度发布不是第一版必须能力，但当前设计已经为它预留了扩展位。

灰度发布要解决的问题：

- 不是所有用户同时切到新 manifest
- 可以小流量试运行
- 出问题时快速停止扩散

## 2. 当前系统可复用的基础

当前已经具备的基础能力：

- immutable artifact 路径
- channel pointer
- manifest 生成
- release graph
- rollback
- notification outbox

这些能力已经足够支撑未来灰度设计。

## 3. 推荐的第一版灰度模型

建议在现有 `channel` 之上增加 `rollout` 概念，而不是直接把 `channel` 拆得很碎。

推荐数据结构：

- `rollout_id`
- `project_key`
- `environment`
- `channel`
- `release_id`
- `audience_selector`
- `traffic_percent`
- `status`
- `started_at`
- `completed_at`

## 4. 路由方式

客户端请求 manifest 时，可以按下面顺序决策：

1. 先确定 `project/environment/channel`
2. 再根据 `audience_selector` 或用户分桶命中 rollout
3. 若命中 rollout，则返回 rollout 绑定 release 的 manifest
4. 否则返回 channel 当前稳定指针

## 5. 需要新增的安全规则

- 同一 audience 不允许同时命中多个 active rollout
- rollback 必须能立即终止 rollout
- promote 到更高渠道前，应先确认 rollout 已完成或已取消
- 灰度中的 release 不应自动被当成默认 stable pointer

## 6. 为什么当前不立即实现

因为第一版已经优先解决：

- 发布主链路
- rollback
- patch 安全
- notifier

而灰度真正要做稳，还需要：

- audience/region 维度
- 客户端分桶约定
- 数据联动
- rollout 监控

这些在当前项目阶段还不是最阻塞项。
