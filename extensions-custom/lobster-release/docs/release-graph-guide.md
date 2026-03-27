# Release Graph 说明

## 1. 目标

`release graph` 用来回答 4 个问题：

- 这个版本从哪里来
- 它是否被 promote 过
- 它是否被 rollback 过
- 它是否替代了别的版本

发布中心里，版本关系不是前端临时算出来的，而是以 `release_relations` 持久化保存。

## 2. 当前关系类型

当前实现里已落地的关系类型包括：

- `derived_from`
  - 新 release 从当前 channel 版本衍生出来
- `promoted_from`
  - 一个稳定 release 被 promote 到另一个 channel 或 environment
- `rolled_back_to`
  - 当前 release 回滚到目标 release
- `replaced_by`
  - 某个 release 被新的已发布版本替代

## 3. 图查询入口

当前已实现的查询入口：

- Tool
  - `release_graph`
  - `release_channel_history`
  - `release_promote_history`
- HTTP
  - `GET /projects/:projectKey/releases/:releaseId/graph`
  - `GET /projects/:projectKey/channels/:channel/graph`
  - `GET /projects/:projectKey/channels/:channel/history`
  - `GET /projects/:projectKey/channels/:channel/promotions`

## 4. 典型用法

### 4.1 单版本追踪

适合定位：

- 某个版本是不是从线上稳定版派生出来的
- 某个版本有没有被 rollback 替代
- 某个版本是不是被 promote 到 release 渠道

看：

- `release_graph`

### 4.2 渠道历史追踪

适合定位：

- beta 当前之前经历了哪些 published 切换
- 当前版本的上一版是谁
- 某次 promote 是否改变了 pointer

看：

- `release_channel_history`

### 4.3 promote 轨迹追踪

适合定位：

- 哪个 beta 版本被推广到了 release
- 同一版本是否被多次 promote
- promote 目标 channel 是否已存在重复版本

看：

- `release_promote_history`

## 5. 当前实现边界

当前 graph 已覆盖：

- release 创建衍生关系
- publish / pointer 替换关系
- promote 关系
- rollback 关系

当前还未覆盖：

- 灰度分流节点
- audience / region 维度边
- patch 包内部资源依赖图

## 6. 运维建议

- 排查“版本来源”优先看 `release_graph`
- 排查“渠道切换历史”优先看 `release_channel_history`
- 排查“推广轨迹”优先看 `release_promote_history`
- 线上事故后，先看 graph 再决定 rollback 目标，不要只凭版本号字符串判断
