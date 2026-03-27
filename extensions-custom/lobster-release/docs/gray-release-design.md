# 灰度发布设计

## 1. 目标

灰度发布最初不是第一版必须能力，但当前实现已经落下了第一层可执行入口。

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

## 6. 当前已经落地的第一层执行能力

当前已经实现：

- `rollout` 持久化记录
- `release_rollout_create / list / advance / cancel`
- `release_route_resolve`
- HTTP 路由：
  - `GET /projects/:projectKey/channels/:channel/rollouts`
  - `POST /projects/:projectKey/channels/:channel/rollouts`
  - `POST /projects/:projectKey/rollouts/:rolloutId/advance`
  - `POST /projects/:projectKey/rollouts/:rolloutId/cancel`
  - `GET /projects/:projectKey/channels/:channel/route`
- 同 scope 活动 rollout 冲突阻断
- rollback 自动取消同 channel 的活动 rollout
- rollout 完成后可选择发布目标 release 并切换 channel pointer

当前的第一版 routing 规则：

1. 先匹配 `project/environment/channel`
2. 再按 `region / audience` 匹配 scope
3. 若命中多个候选 rollout，优先更具体的 scope，再优先更高流量，再优先最新更新时间
4. 用 `bucketValue` 或 `subjectKey` 的稳定哈希决定是否命中 rollout
5. 未命中则回退到 channel 当前稳定指针

## 7. 仍未完成的部分

虽然第一层执行能力已经具备，但灰度要真正稳定运营，还缺：

- audience/region 维度
- 客户端分桶约定
- 数据联动
- rollout 监控
- rollout 指标门禁
- 自动扩量和自动熔断

这些在当前项目阶段还不是最阻塞项。
