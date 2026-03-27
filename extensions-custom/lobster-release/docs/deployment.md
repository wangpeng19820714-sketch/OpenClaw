# 部署说明

## 1. 当前推荐部署形态

第一版推荐：

- 单个 OpenClaw gateway 实例
- 本地或单点可写状态目录
- 单个 `lobster-release.sqlite`
- Jenkins 与 gateway 网络互通

这是当前已经验证过的最稳方案。

## 2. 目录要求

`lobster-release` 运行时会使用这些目录：

- `plugins/lobster-release/lobster-release.sqlite`
- `plugins/lobster-release/manifests/...`
- `plugins/lobster-release/uploads/...`

其中：

- `sqlite` 用于 release/build/artifact/audit/outbox
- `manifests` 保存 release manifest
- `uploads` 保存 Jenkins 回传后的产物映射目录

## 3. 必需配置

最关键的运行配置：

- `defaultProjectKey`
- `defaultEnvironment`
- `defaultChannel`
- `routePrefix`
- `ciRoutePrefix`
- `publicBaseUrl`
- `ciApiKey`
- `ciApiSecret`
- `jenkinsBaseUrl`
- `jenkinsJob`
- `jenkinsUser`
- `jenkinsApiToken`

如果要启用 notifier：

- `notifierSessionKey`

## 4. 密钥管理

真实密钥应放在：

- `.env`

不应把这些值直接写入已提交配置：

- `ciApiSecret`
- `jenkinsApiToken`
- `OPENCLAW_GATEWAY_TOKEN`

## 5. 部署前检查

- OpenClaw gateway 能正常启动
- `lobster-release` 插件已加载
- Jenkins 可以访问 `publicBaseUrl`
- Jenkins credentials 已创建
- 上传目录可写
- `local-macos` 或实际 Jenkins agent 在线

## 6. 生产化建议

如果后续进入长期运营，建议升级：

- SQLite -> PostgreSQL
- 本地 uploads -> 对象存储或稳定静态文件服务
- 单实例锁 -> 分布式锁
- 人工轮询 -> 统一监控和告警
