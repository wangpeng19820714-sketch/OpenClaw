# Lobster Release 开发 Checklist

## 1. 目标

本清单用于跟踪 `lobster-release` 的开发进度。

定位：

- `lobster-release` 是 Godot 项目的版本发布中心
- `lobster-release` 主动触发 Jenkins 构建
- Jenkins 作为构建执行器，负责编译、导出、上传和结果回传
- OpenClaw 负责通知、查询、审批和后续自动化

说明：

- 已完成并已落到仓库中的项标记为 `[x]`
- 尚未实现或需要联调/部署验证的项标记为 `[ ]`
- 本清单聚焦 `extensions-custom/lobster-release` 的开发，不把 Jenkins UI 的人工操作视为已完成

## 2. 当前已完成

- [x] 在 `extensions-custom` 下创建 `lobster-release` 目录
- [x] 创建 `extensions-custom/lobster-release/docs` 目录
- [x] 输出发布中心设计草案
- [x] 明确 `lobster-release` 是发布主控，Jenkins 是执行器
- [x] 明确版本号治理应由发布中心负责
- [x] 明确 `major / minor / patch` 中文含义和业务语义

落点：

- [extensions-custom/lobster-release/README.md](extensions-custom/lobster-release/README.md)
- [extensions-custom/lobster-release/docs/release-center-design.md](extensions-custom/lobster-release/docs/release-center-design.md)

## 3. 需求与规则固化

- [ ] 确认第一版是否只支持单项目，还是支持多项目
- [ ] 确认第一版数据库选型：SQLite 或 PostgreSQL
- [ ] 确认第一版存储选型：本地目录、MinIO、OSS 或 S3
- [ ] 确认渠道集合是否固定为 `dev / beta / release`
- [ ] 确认 `dev` 是否允许自动发布
- [ ] 确认 `beta` 是否必须人工审批
- [ ] 确认 `release` 是否必须人工审批
- [ ] 确认 patch 发布是否必须依赖 baseline manifest
- [ ] 确认是否允许同一版本 rebuild
- [ ] 确认是否支持 prerelease 版本，如 `1.2.3-beta.1`

## 4. 版本号治理

- [ ] 定义第一版版本格式校验规则
- [ ] 实现严格三段版本 `major.minor.patch` 校验
- [ ] 实现版本比较逻辑
- [ ] 实现重复版本阻止逻辑
- [ ] 实现版本回退阻止逻辑
- [ ] 实现 `patch / minor / major` 自动判定逻辑
- [ ] 实现版本号建议逻辑 `suggest`
- [ ] 实现版本来源标记：`manual / suggested / enforced`
- [ ] 实现基于版本变化类型的 baseline 策略
- [ ] 输出 `versioning` 配置 schema 文档

## 5. 核心数据模型

- [ ] 定义 `project` 数据模型
- [ ] 定义 `release` 数据模型
- [ ] 定义 `build` 数据模型
- [ ] 定义 `artifact` 数据模型
- [ ] 定义 `patch_baseline` 数据模型
- [ ] 定义 `release_channel_state` 数据模型
- [ ] 定义 `event_log` 数据模型
- [ ] 设计各表主键、唯一键和索引
- [ ] 设计 release 和 build 的幂等键规则
- [ ] 设计审计事件保留策略

## 6. 状态机与领域规则

- [ ] 固化 `draft -> building -> built -> awaiting_approval -> published` 状态流
- [ ] 定义 `failed` 状态进入规则
- [ ] 定义 `rolled_back` 状态进入规则
- [ ] 实现 release 状态迁移校验
- [ ] 实现 build 状态迁移校验
- [ ] 实现渠道指针更新规则
- [ ] 实现 rollback 时的前版本恢复规则
- [ ] 实现人工审批与自动发布的互斥规则

## 7. API 设计

### 发布中心内部 API

- [ ] 定义 `POST /api/projects/:projectKey/releases`
- [ ] 定义 `POST /api/projects/:projectKey/releases/:releaseId/trigger`
- [ ] 定义 `GET /api/projects/:projectKey/releases/:releaseId`
- [ ] 定义 `GET /api/projects/:projectKey/channels/:channel/current`
- [ ] 定义 `POST /api/projects/:projectKey/releases/:releaseId/approve`
- [ ] 定义 `POST /api/projects/:projectKey/channels/:channel/rollback`

### baseline API

- [ ] 定义 `GET /api/projects/:projectKey/baselines/resolve`
- [ ] 明确 baseline 选择规则
- [ ] 明确 baseline 不存在时的处理逻辑

### Jenkins 回传 API

- [ ] 定义 `POST /api/projects/:projectKey/builds/:buildId/start`
- [ ] 定义 `POST /api/projects/:projectKey/builds/:buildId/publish`
- [ ] 定义 `POST /api/projects/:projectKey/builds/:buildId/finish`
- [ ] 定义统一错误码和错误响应结构

## 8. Jenkins 集成

- [ ] 确认 Jenkins 触发方式：`buildWithParameters` 或其他 API
- [ ] 实现 `lobster-release -> Jenkins` 触发适配层
- [ ] 定义 Jenkins API token 或凭据加载方式
- [ ] 统一传递 `RELEASE_ID`
- [ ] 统一传递 `BUILD_ID`
- [ ] 统一传递 Git 参数
- [ ] 统一传递构建目标参数
- [ ] 统一传递 baseline 参数
- [ ] 统一传递 callback 鉴权参数
- [ ] 支持 Jenkins queue id / build number 回写
- [ ] 支持主动轮询 Jenkins 状态
- [ ] 支持 Jenkins 失败后的重试或人工重触发

## 9. 产物与 Manifest

- [ ] 定义统一 artifact 结构
- [ ] 定义 `release_manifest.json` schema
- [ ] 定义 artifact type 枚举
- [ ] 实现 `uploaded_artifacts.json` 到内部 artifact 结构的映射
- [ ] 实现统一下载 URL 生成规则
- [ ] 实现 SHA-256 校验逻辑
- [ ] 实现产物去重逻辑
- [ ] 实现 release 级 manifest 生成
- [ ] 实现 patch 产物与 baseline 的关联记录

## 10. 存储与持久化

- [ ] 初始化数据库迁移方案
- [ ] 实现 repository/store 层
- [ ] 实现 release 持久化
- [ ] 实现 build 持久化
- [ ] 实现 artifact 持久化
- [ ] 实现 baseline 持久化
- [ ] 实现 event log 持久化
- [ ] 实现渠道状态持久化
- [ ] 设计定期清理策略

## 11. 安全与可靠性

- [ ] 设计 `lobster-release -> Jenkins` 鉴权方案
- [ ] 设计 `Jenkins -> lobster-release` HMAC 鉴权方案
- [ ] 加入 `timestamp` 校验
- [ ] 加入 `nonce` 校验
- [ ] 加入 `idempotency-key` 校验
- [ ] 实现幂等消费记录
- [ ] 实现接口级限流或最小保护
- [ ] 实现失败事件记录
- [ ] 实现回调失败重试策略
- [ ] 输出联调鉴权文档

## 12. OpenClaw 集成

- [ ] 设计 OpenClaw 调用 `lobster-release` 的方式
- [ ] 实现版本查询工具或命令
- [ ] 实现构建状态查询工具或命令
- [ ] 实现版本审批工具或命令
- [ ] 实现渠道 promote 工具或命令
- [ ] 实现 rollback 工具或命令
- [ ] 实现构建开始通知
- [ ] 实现构建失败通知
- [ ] 实现待审批通知
- [ ] 实现发布成功通知

## 13. 服务骨架与代码结构

- [ ] 创建 `src/` 目录
- [ ] 创建 `src/server/`
- [ ] 创建 `src/domain/`
- [ ] 创建 `src/storage/`
- [ ] 创建 `src/openclaw/`
- [ ] 创建 `package.json`
- [ ] 创建 `openclaw.plugin.json` 或服务配置文件
- [ ] 创建环境变量示例文件
- [ ] 创建本地开发启动脚本

## 14. 测试

- [ ] 为版本号校验编写测试
- [ ] 为版本比较逻辑编写测试
- [ ] 为状态机编写测试
- [ ] 为 baseline 选择逻辑编写测试
- [ ] 为 manifest 生成逻辑编写测试
- [ ] 为 Jenkins 参数映射编写测试
- [ ] 为回调鉴权编写测试
- [ ] 为幂等逻辑编写测试
- [ ] 为 rollback 流程编写测试
- [ ] 增加 API 集成测试

## 15. 联调与验收

- [ ] 本地启动 `lobster-release` 服务
- [ ] 本地模拟创建 release
- [ ] 本地模拟触发 Jenkins
- [ ] 验证 Jenkins 参数传递正确
- [ ] 验证 Jenkins 回传 `publish`
- [ ] 验证 Jenkins 回传 `finish`
- [ ] 验证 `release_manifest.json` 生成正确
- [ ] 验证渠道状态更新正确
- [ ] 验证审批流正确
- [ ] 验证 rollback 流正确
- [ ] 验证 patch baseline 解析正确
- [ ] 验证重复回调幂等处理正确

## 16. 文档

- [x] 输出总体设计文档
- [x] 输出开发 Checklist
- [ ] 输出 API 契约文档
- [ ] 输出 `release_manifest.json` schema 文档
- [ ] 输出版本号治理文档
- [ ] 输出 Jenkins 集成文档
- [ ] 输出部署文档
- [ ] 输出故障排查文档

落点：

- [extensions-custom/lobster-release/docs/release-center-design.md](extensions-custom/lobster-release/docs/release-center-design.md)
- [extensions-custom/lobster-release/docs/Task_Checklist.md](extensions-custom/lobster-release/docs/Task_Checklist.md)

## 17. 第一阶段建议验收标准

- [ ] 能创建一个 release
- [ ] 能由 `lobster-release` 主动触发 Jenkins
- [ ] 能接收 Jenkins `publish / finish` 回传
- [ ] 能生成统一 `release_manifest.json`
- [ ] 能正确记录版本号、渠道、构建号、产物和 baseline
- [ ] 能在 OpenClaw 中查询当前版本和构建状态

## 18. 下一步优先级

建议优先顺序：

1. 版本号规则与 `versioning` schema
2. 核心数据模型与状态机
3. Jenkins 触发接口与回传接口
4. `release_manifest.json`
5. OpenClaw 查询与审批入口
