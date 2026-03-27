# 并发锁与串行发布说明

## 1. 目标

`lobster-release` 当前通过 `operation_locks` 保证同一条发布链上的关键操作串行执行，避免：

- 同一 channel 同时 approve 两个 release
- promote 和 rollback 同时改 pointer
- rollback 执行时又有普通 publish 落下

## 2. 当前锁模型

锁粒度：

- `lock_scope = channel`

锁 key：

- `${projectKey}:${environment}:channel:${channel}`

当前已接入锁的操作：

- `approveRelease`
- `promoteRelease`
- `approveRollback`

## 3. 锁行为

- 锁默认 5 分钟过期
- 每次关键操作前都会先清理过期锁
- 若锁已被占用，则直接拒绝当前操作
- 当前实现优先保证“不写乱状态”，而不是排队等待

## 4. 为什么只锁 channel

当前 pointer、stable 状态、rollback 目标都天然属于 channel 维度，所以第一版锁 channel 就能覆盖最大风险。

这样做的优点：

- 实现简单
- 行为可预测
- 能直接覆盖 publish / promote / rollback 三个高风险操作

当前不做更细粒度锁的原因：

- release 级锁无法覆盖 pointer 竞争
- build 级锁不能避免两个版本同时 publish 到同一 channel

## 5. 当前边界

当前锁还没有：

- 等待队列
- 锁可视化页面
- 锁续租
- 多实例分布式一致性

因此第一版更适合：

- 单实例 gateway
- 本地 SQLite 或单点数据库

## 6. 未来扩展方向

- 如果未来变成多实例部署，应把锁升级到数据库原子写或 Redis 分布式锁
- 如果要做灰度发布，需要把锁维度扩展到：
  - `channel + audience`
  - 或 `channel + rolloutId`
- 如果要支持人工审批队列，可以在拒绝冲突前增加排队层
