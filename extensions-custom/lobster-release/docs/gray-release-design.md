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

## 7. 当前已经补齐的监控与自动动作

当前实现已经从“手工灰度工具”推进到了“可执行 rollout 流程”：

- `rollout.status` 新增了 `paused` 语义
  - `paused` rollout 仍保留记录和人工恢复入口
  - `paused` rollout 不再参与客户端路由命中
- 已新增 rollout 观测记录
  - `rollout.observed`
  - 观测项包括 `sampleSize / successCount / errorCount / crashCount / latencyP95Ms`
- 已新增 rollout 健康评估
  - `healthy`
  - `unhealthy`
  - `insufficient_data`
  - `disabled`
- 已新增自动动作
  - 健康时自动扩量到下一个 `rolloutPercentages`
  - 到达最终步长后可自动完成并发布 release
  - 不健康时按策略自动 `pause` 或 `cancel`

## 8. 当前可执行接口

除原有 rollout 控制接口外，当前还新增：

- `GET /projects/:projectKey/rollouts/:rolloutId/status`
- `POST /projects/:projectKey/rollouts/:rolloutId/observe`
- `POST /projects/:projectKey/rollouts/:rolloutId/evaluate`

对应 OpenClaw tools：

- `release_rollout_status`
- `release_rollout_observe`
- `release_rollout_evaluate`
- `release_rollout_tick`
- `release_rollout_tick_all`

当前建议的自动巡检方式：

1. 外部监控系统先汇总一个时间窗的指标
2. 调 `release_rollout_tick` 直接把样本写入并触发一次评估
3. 或定时调 `release_rollout_tick_all`，批量扫描该 channel 下所有活动 rollout
4. 由 runtime 根据 monitoring 配置自动决定：
   - 扩量
   - 完成并发布
   - pause
   - cancel

当前实现还支持在插件服务内注册真正的定时巡检：

- 当 `grayRelease.monitoring.tickCron` 配置存在时，`lobster-release` 会在 service 启动时按 cron 表达式自动调度对应 `project/environment/channel` 的 `tick_all`
- 定时任务不依赖 agent prompt 或 LLM 推理，直接调用 runtime 的 `tickAllRollouts(...)`
- 每次定时巡检都会自动复用已有 observation，按既有监控策略执行：
  - 扩量
  - 完成并发布
  - pause
  - cancel
- 若本轮没有活动 rollout，则仅记录调度日志，不会产生副作用

## 9. 正式配置建议

灰度策略不应只靠 drill 时临时 override，推荐直接写进项目正式配置：

```json
{
  "projects": {
    "gamexpert": {
      "grayRelease": {
        "enabled": true,
        "rolloutPercentages": [5, 10, 25, 50, 100],
        "stickiness": "account",
        "monitoring": {
          "enabled": true,
          "tickCron": "*/5 * * * *",
          "minSampleSize": 100,
          "minSuccessRate": 0.95,
          "maxErrorRate": 0.05,
          "maxCrashRate": 0.02,
          "autoAdvance": true,
          "autoAdvanceAfterMinutes": 0,
          "publishOnComplete": true,
          "circuitBreakerAction": "pause"
        }
      }
    }
  }
}
```

## 10. 仍未完成的长期项

当前还没有真正接入外部运营数据系统，所以仍未完成：

- 指标自动采集
- 版本与运营数据联动
- 自动熔断后的通知编排升级
- 多 rollout 并行实验的全链路治理
