# 部署说明

## 0. 一键安装形态

`lobster-release` 当前已经整理为可独立发布的 npm 插件包形态。

目标 OpenClaw 节点可直接安装：

```bash
openclaw plugins install @openclaw/lobster-release
openclaw plugins enable lobster-release
```

如果你发布的是自己的 fork，需要把安装命令替换成你自己的 npm spec，例如：

```bash
openclaw plugins install @your-scope/openclaw-lobster-release
```

安装后仍然需要：

- 重启 gateway
- 配置 `plugins.entries.lobster-release.config`
- 准备 PostgreSQL 与 Jenkins 连通性

## 1. 当前推荐部署形态

当前已经验证过的稳定形态：

- 单个 OpenClaw gateway 实例
- 本地或单点可写状态目录
- 单个 `lobster-release.sqlite`
- Jenkins 与 gateway 网络互通

这是当前已经验证过的最稳方案。

## 2. 目标生产部署形态

下一阶段推荐：

- 单个 OpenClaw gateway 实例
- 单个 PostgreSQL 容器
- 一个 PostgreSQL 持久化 volume
- 本地或对象存储形式的 manifest / uploads 目录
- Jenkins 与 gateway 网络互通

推荐原因：

- 现在 `lobster-release` 已经有 release/build/rollback/rollout/outbox/locks
- 这些状态更适合事务型数据库
- PostgreSQL 更适合多人协作、长期运营和并发写入

推荐的 Docker 形态：

- `postgres:16`
- 独立 volume 保存数据库文件
- 用 `.env` 注入连接信息
- gateway 通过 `DATABASE_URL` 或拆分后的连接参数访问 Postgres

## 3. 目录要求

`lobster-release` 运行时会使用这些目录：

- `plugins/lobster-release/lobster-release.sqlite`
- `plugins/lobster-release/manifests/...`
- `plugins/lobster-release/uploads/...`

其中：

- `sqlite` 用于 release/build/artifact/audit/outbox
- `manifests` 保存 release manifest
- `uploads` 保存 Jenkins 回传后的产物映射目录

如果切到 PostgreSQL：

- `lobster-release.sqlite` 会被数据库连接配置替代
- `manifests` 和 `uploads` 目录仍然保留

## 4. 必需配置

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

如果切到 PostgreSQL in Docker，建议新增：

- `LOBSTER_DB_DRIVER=postgres`
- `LOBSTER_DB_HOST=postgres`
- `LOBSTER_DB_PORT=5432`
- `LOBSTER_DB_NAME=lobster_release`
- `LOBSTER_DB_USER=lobster`
- `LOBSTER_DB_PASSWORD=<secret>`

## 5. 密钥管理

真实密钥应放在：

- `.env`

不应把这些值直接写入已提交配置：

- `ciApiSecret`
- `jenkinsApiToken`
- `OPENCLAW_GATEWAY_TOKEN`

如果切到 PostgreSQL：

- 数据库密码也应放进 `.env`
- 不要把 `DATABASE_URL` 或明文密码写进已提交配置

## 6. 部署前检查

- OpenClaw gateway 能正常启动
- `lobster-release` 插件已加载
- Jenkins 可以访问 `publicBaseUrl`
- Jenkins credentials 已创建
- 上传目录可写
- `local-macos` 或实际 Jenkins agent 在线

如果是 PostgreSQL in Docker 方案，还应检查：

- PostgreSQL 容器已启动
- gateway 能连通数据库
- 数据库 migration / bootstrap 已执行
- volume 已挂载并具备持久化

## 7. PostgreSQL in Docker 开发拆解

- 抽象 `SQLite / PostgreSQL` 双后端 store 接口
- 第一阶段新增 `PostgreSQL` store（startup preload + cache-backed CRUD + serial write queue）
- 增加数据库连接配置
- 增加 migration / bootstrap
- 已将核心 `create / CI callback / approve` 主路径推进到兼容 PostgreSQL 的 async direct-store
- 已将剩余 `rollout / rollback / promote / maintenance` 主路径继续推进为 async direct-store
- 增加 `docker compose` 样例
- 增加 `SQLite -> PostgreSQL` 迁移脚本
- 已完成两轮 `PostgreSQL in Docker` 的真实 `runtime/http` API drill
  - 第一轮覆盖 `create / CI callback / approve / query`
  - 第二轮覆盖 `rollout / route / rollback / maintenance`

当前已提供：

- `extensions-custom/lobster-release/docker-compose.postgres.yml`
- `scripts/lobster-release-migrate-postgres.mjs`
- `pnpm lobster:migrate:postgres`

推荐迁移命令：

```bash
LOBSTER_SQLITE_PATH=/path/to/lobster-release.sqlite \
LOBSTER_POSTGRES_URL=postgres://lobster:secret@127.0.0.1:5432/lobster_release \
LOBSTER_POSTGRES_SCHEMA=lobster_release \
pnpm lobster:migrate:postgres --truncate
```

只预览不写入：

```bash
LOBSTER_SQLITE_PATH=/path/to/lobster-release.sqlite \
LOBSTER_POSTGRES_URL=postgres://lobster:secret@127.0.0.1:5432/lobster_release \
pnpm lobster:migrate:postgres --dry-run
```

## 8. 生产化建议

如果后续进入长期运营，建议升级：

- SQLite -> PostgreSQL
- 本地 uploads -> 对象存储或稳定静态文件服务
- 单实例锁 -> 分布式锁
- 人工轮询 -> 统一监控和告警
