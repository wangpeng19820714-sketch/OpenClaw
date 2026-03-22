# OpenClaw Godot 版本发布中心设计草案

## 1. 背景

你当前已经有一条可用的 Jenkins 构建流水线，且文档里已经覆盖了以下关键能力：

- Source / Prepare / Android / macOS / Patch / Publish / Post 全阶段串联
- Patch 基线查询、构建开始、产物发布、构建完成四个“龙虾”回调点
- 本地目录上传、结构化产物 JSON 输出、mock 联调链路

但从 Checklist 来看，真正决定“版本发布中心”是否可上线的能力还没有完全收口：

- OSS / S3 / CDN 正式上传实现未完成
- 统一的下载 URL 清单未完成
- 正式鉴权和全链路幂等策略未完成
- 回调失败重试策略未完成

所以发布中心的首要任务，不是替代 Jenkins 构建，而是把 Jenkins 已经产出的构建结果变成一个可管理、可查询、可审批、可推广、可回滚的发布系统。

## 2. 系统定位

建议把 `lobster-release` 定位为：

- 发布中心和主控面：负责创建 release、维护状态机、决定是否触发构建
- Jenkins 的上游编排者：主动调用 Jenkins 创建或推进构建任务
- OpenClaw 的发布控制面：通过消息、工具或 Web UI 给人看、给人批、给人查

职责边界建议这样切：

- Jenkins：纯执行器，负责拉代码、编译、签名、导出、上传文件
- Artifact Storage：保存 APK / AAB / macOS zip / patch 包 / manifest / sha256
- Lobster Release：保存元数据、管理版本状态、查询基线、触发 Jenkins、接收执行结果、生成统一下载清单、处理审批与推广
- OpenClaw：提供通知、命令入口、审批流和后续自动化编排

这个边界很重要。不要让发布中心重新做 Jenkins 已经做好的构建逻辑，也不要让 Jenkins 去承担版本中心的业务规则。换句话说，Jenkins 是 release center 的 worker，不是 release center 的 owner。

## 3. 核心目标

建议把第一版目标收敛成 6 件事：

1. 管理一次构建对应的所有产物和元数据
2. 管理版本与渠道的关系，比如 `dev`、`beta`、`release`
3. 管理 patch 基线、兼容版本和增量包信息
4. 输出统一、稳定、可签名的下载清单
5. 提供审批、发布、回滚、重试和审计记录
6. 能被 Jenkins 调用，也能被 OpenClaw 查询和操作

非目标也建议提前说清：

- 第一版不做完整的下载站前台
- 第一版不自己存储大文件，只存元数据和 URL
- 第一版不做复杂多租户权限系统
- 第一版不做跨项目通用工作流引擎，先围绕 Godot 游戏发版做深

## 4. 推荐产品形态

建议分两层：

### 4.1 API + 状态中心

这是最核心的一层，用于创建发布任务、调用 Jenkins 并维护发布状态。

最小能力：

- 创建 release 和 build
- 查询 baseline 并决定 patch 构建参数
- 主动调用 Jenkins job 或 Jenkins build API
- 接收 Jenkins 回传状态或主动轮询 Jenkins 状态
- 保存 release / build / artifact / baseline / event_log
- 返回统一 JSON

### 4.2 OpenClaw 交互层

这是“好用”的关键，但不一定第一天就做成完整 Web UI。

推荐先做：

- OpenClaw 工具或命令：查构建、查版本、批准发布、执行回滚
- OpenClaw 通知：构建开始、构建失败、待审批、正式发布成功
- 后续再补轻量 Web 页面或 dashboard

也就是说，第一版优先做“可用的发布后端 + OpenClaw 聊天式控制”，而不是先堆一个复杂前端。

## 5. 建议的数据模型

建议至少有下面几类对象。

### 5.1 project

定义项目维度。

关键字段：

- `project_id`
- `project_key`
- `name`
- `engine`，固定可先用 `godot`
- `default_channel`
- `created_at`

### 5.2 release

表示一个对外可感知的版本。

关键字段：

- `release_id`
- `project_id`
- `version`
- `display_version`
- `channel`
- `status`
- `git_branch`
- `git_commit`
- `build_number`
- `notes`
- `created_at`

建议 `status` 至少包括：

- `draft`
- `building`
- `built`
- `awaiting_approval`
- `published`
- `failed`
- `rolled_back`

### 5.3 build

表示 Jenkins 一次具体构建执行。

关键字段：

- `build_id`
- `release_id`
- `jenkins_job`
- `jenkins_build_number`
- `triggered_by`
- `source_git_url`
- `source_git_branch`
- `source_git_commit`
- `started_at`
- `finished_at`
- `result`
- `baseline_version`
- `baseline_manifest_url`

### 5.4 artifact

描述上传后的单个产物。

关键字段：

- `artifact_id`
- `build_id`
- `artifact_type`
- `platform`
- `channel`
- `file_name`
- `file_size`
- `sha256`
- `storage_provider`
- `storage_path`
- `download_url`
- `manifest_role`

`artifact_type` 建议先支持：

- `android_apk`
- `android_aab`
- `macos_zip`
- `patch_bundle`
- `patch_manifest`
- `patch_list`
- `build_report`
- `sha256`

### 5.5 patch_baseline

表示增量包基线关系。

关键字段：

- `baseline_id`
- `project_id`
- `platform`
- `channel`
- `from_version`
- `to_version`
- `baseline_manifest_url`
- `patch_manifest_url`
- `compatibility_rule`

### 5.6 release_channel_state

表示某个渠道当前指向哪个版本。

关键字段：

- `project_id`
- `channel`
- `current_release_id`
- `previous_release_id`
- `updated_at`

### 5.7 event_log

用于审计和排障。

关键字段：

- `event_id`
- `object_type`
- `object_id`
- `event_type`
- `request_id`
- `idempotency_key`
- `payload_json`
- `created_at`

## 6. 推荐状态机

建议统一状态流，不要让 Jenkins 随意写任何状态。

标准流：

1. `draft`
2. `building`
3. `built`
4. `awaiting_approval`
5. `published`

异常流：

- 任一步都可以进入 `failed`
- `published` 可以进入 `rolled_back`

配套规则：

- `lobster-release` 在成功触发 Jenkins 后把 release 从 `draft` 推到 `building`
- Jenkins `publish` 只能在 `building` 或 `built` 时写入产物
- Jenkins `finish success` 只能把状态推进到 `built`
- 只有人工批准或自动规则命中后，`built` 才能推进到 `published`

这能避免“Jenkins 一跑完就算发布成功”的状态污染。

## 7. 版本号治理建议

可以，`lobster-release` 应该主动理解和维护版本号规则，而不是只把版本号当成一个字符串。

如果发布中心不掌握版本语义，会直接带来几个问题：

- 无法判断这次发布到底是热修复、功能更新还是破坏性升级
- 无法自动决定 patch baseline 是否还能复用
- 无法根据渠道决定是否允许自动 promote
- 无法阻止错误版本号覆盖线上渠道

所以建议把“版本号治理”作为发布中心的一等能力。

### 7.1 建议的基础语义

如果你现在使用 `0.0.0` 这种三段式版本，推荐先定义成：

- `major.minor.patch`

含义建议如下：

- `major`：主版本
  中文含义：大版本、破坏性版本、不兼容升级版本
  适用场景：资源结构大改、协议变更、存档不兼容、热更新规则重做、patch 基线需要整体重置
- `minor`：次版本
  中文含义：功能版本、小版本、兼容性功能迭代版本
  适用场景：在保持整体兼容的前提下增加新功能、新内容、新资源包或较明显的模块增强
- `patch`：补丁版本
  中文含义：修订版本、热修复版本、问题修复版本
  适用场景：bugfix、小资源修正、脚本修补、配置修复、局部问题修复，原则上不改大结构

建议在团队口径里统一这样说：

- `major` = 主版本 / 大版本
- `minor` = 次版本 / 功能版本
- `patch` = 补丁版本 / 热修复版本

对 Godot 项目，我建议额外明确一条：

- 如果本次变更导致热更新资源布局、补丁加载协议或客户端兼容策略变化，应强制提升 `major` 或至少禁止沿用旧 baseline

也就是说，这不是纯语义化版本的教科书定义，而是要结合你们的 patch/热更新现实。

### 7.2 发布中心应负责的判断

`lobster-release` 至少应主动做下面几类判断：

1. 校验版本格式是否合法
2. 校验新版本是否大于目标渠道当前版本
3. 根据版本变化判断变更级别
4. 根据变更级别决定默认发布策略
5. 根据变更级别判断 baseline 是否还能复用

例如：

- `1.4.2 -> 1.4.3`：默认视为 patch
- `1.4.2 -> 1.5.0`：默认视为 minor
- `1.4.2 -> 2.0.0`：默认视为 major

### 7.3 版本变更级别与发布策略

建议让发布中心自动推导一个 `version_bump_type`：

- `patch`
- `minor`
- `major`

然后映射到默认策略：

- `patch`：允许走快速审批或自动进 `beta`
- `minor`：默认要求审批，允许生成 patch，但要重新检查 baseline
- `major`：默认禁止自动发布，要求人工审批，并通常重置 patch baseline

### 7.4 版本比较规则

建议第一版直接做严格比较，不要一开始就放太松。

基本规则：

- 同一 channel 内，新版本必须严格大于当前版本
- 不允许重复发布相同 `version + channel + commit` 组合，除非显式选择 rebuild
- 不允许比当前渠道版本更小的版本覆盖当前渠道
- `release` 渠道禁止跳过审批直接推进

示例：

- 当前 `beta` 为 `1.3.5`，提交 `1.3.5`：拒绝，视为重复版本
- 当前 `beta` 为 `1.3.5`，提交 `1.3.4`：拒绝，视为版本回退
- 当前 `beta` 为 `1.3.5`，提交 `1.4.0`：允许，但进入审批流

### 7.5 版本号自动建议

发布中心不一定要完全自动“改版本”，但至少应该能自动“建议版本”。

建议支持三种模式：

- `manual`：调用方直接传完整版本号
- `suggest`：发布中心根据当前渠道版本自动建议下一个版本号
- `enforce`：发布中心根据规则生成版本号，外部不能随便指定

对于第一版，我建议上：

- `manual + validate`
- 可选 `suggest`

先不要直接上 `enforce`，否则早期会把研发流程绑得太死。

### 7.6 建议版本号的输入信号

如果要让 `lobster-release` 具备“建议版本号”的能力，可以先依赖这些输入信号：

- 用户显式指定的 bump 类型：`patch / minor / major`
- 目标渠道当前版本
- Git commit 或 tag
- 构建目标类型：是否包含 patch、Android、macOS
- 可选的发布说明标签，比如 `breaking`、`feature`、`hotfix`

后续如果你们流程成熟了，再增加更智能的判定：

- 分析 commit message
- 分析 PR label
- 分析变更文件范围
- 分析是否涉及 `asset_groups.json`、manifest schema、热更新加载逻辑

但这个智能判定只能做建议，不能第一版就拿它当唯一依据。

### 7.7 baseline 与版本号联动

建议把 baseline 策略直接和版本变更类型挂钩。

默认规则可以是：

- `patch`：优先复用当前渠道最近一次稳定 baseline
- `minor`：允许复用 baseline，但必须做兼容校验
- `major`：默认不复用旧 baseline，要求创建新的 baseline 起点

如果以后发现这个规则太死，可以把它做成项目级配置。

### 7.8 配置化建议

建议把版本规则做成项目配置，而不是写死在代码里。

例如：

```json
{
  "versioning": {
    "scheme": "semver3",
    "allowPrerelease": false,
    "defaultMode": "manual",
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
        "allowBumpTypes": ["patch", "minor", "major"],
        "requireApproval": true
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

这样后面如果你要支持：

- `1.2.3-beta.1`
- 日期版本
- 四段版本号

也不会把核心逻辑写死。

### 7.9 数据模型补充

为了让发布中心真正管理版本号，建议在 `release` 或单独表里补这些字段：

- `version_scheme`
- `version_major`
- `version_minor`
- `version_patch`
- `version_prerelease`
- `version_buildmeta`
- `version_bump_type`
- `version_source`

其中：

- `version_bump_type`：`patch | minor | major`
- `version_source`：`manual | suggested | enforced`

### 7.10 实际落地建议

如果按实现优先级排，我建议这样做：

1. 第一版先支持严格三段版本 `major.minor.patch`
2. 发布中心负责校验、比较、拒绝降级和重复覆盖
3. 发布中心支持根据 `patch/minor/major` 给出建议版本
4. 先不支持复杂 prerelease 规则
5. 等主流程跑顺后，再加 `-beta.N` 之类的预发布版本

这个顺序更稳，因为你当前最重要的是先把发布主控做起来，不是把版本语法做成通用包管理器。

## 8. Jenkins 对接接口建议

如果由 `lobster-release` 主动调 Jenkins，那么正式接口应该分成两组：

- 发布中心内部 API：给 OpenClaw、前端或命令入口调用
- Jenkins 适配接口：给 `lobster-release` 调 Jenkins，或接 Jenkins 的最小结果回传

这样 Jenkins 端改动会更小，业务中心也更清晰。

### 7.1 发布中心内部 API

建议先有这几个入口：

`POST /api/projects/:projectKey/releases`

作用：

- 创建一次 release 请求
- 选择目标渠道和构建目标
- 决定是否立即触发 Jenkins

请求体建议包含：

- `version`
- `channel`
- `git`
- `targets`
- `notes`
- `triggerBuild`

`POST /api/projects/:projectKey/releases/:releaseId/trigger`

作用：

- 基于已有 release 主动触发 Jenkins
- 由发布中心先完成 baseline 解析、参数归一化、幂等校验

返回建议：

- `releaseId`
- `buildId`
- `jenkinsQueueId`
- `jenkinsJob`
- `status`

### 7.2 发布中心到 Jenkins

这层不是给人用的业务 API，而是 `lobster-release` 对 Jenkins 的适配。

可以有两种模式：

- 模式 A：`lobster-release` 调 Jenkins `buildWithParameters`
- 模式 B：`lobster-release` 写任务到队列，Jenkins 定时拉取

对你当前场景，我更推荐模式 A，原因很直接：

- 你已经有参数化 Jenkinsfile
- 你已经明确了构建参数和产物结构
- 主动推 Jenkins 比让 Jenkins 轮询更简单

触发时建议由 `lobster-release` 统一拼这些参数：

- `GIT_URL`
- `GIT_BRANCH`
- `GIT_COMMIT`
- `BUILD_ANDROID_APK`
- `BUILD_ANDROID_AAB`
- `BUILD_MACOS_APP`
- `BUILD_PATCH`
- `BASELINE_VERSION`
- `BASELINE_MANIFEST_URL`
- `RELEASE_ID`
- `BUILD_ID`
- `CALLBACK_BASE_URL`
- `CALLBACK_TOKEN`

### 7.3 查询 patch baseline

`GET /api/projects/:projectKey/baselines/resolve`

查询参数建议：

- `platform`
- `channel`
- `targetVersion`
- `gitCommit`

返回建议：

- `baselineVersion`
- `baselineManifestUrl`
- `baselineReleaseId`
- `patchStrategy`

### 7.4 Jenkins 回传产物发布

`POST /api/projects/:projectKey/builds/:buildId/publish`

请求体建议直接复用你现有的 `uploaded_artifacts.json`，但要在服务端归一化成统一结构。这里 Jenkins 不再是“创建发布对象”的一方，而只是“报告构建执行结果”的一方。

服务端需要做三件事：

- 校验 `sha256`
- 补全统一 `download_url`
- 生成 release 级别 `release_manifest.json`

### 7.5 Jenkins 回传构建完成

`POST /api/projects/:projectKey/builds/:buildId/finish`

请求体建议包含：

- `status`
- `summary`
- `durationSeconds`
- `reports`
- `artifactsCount`
- `error`

成功后不要直接发布到渠道，而是：

- `dev` 可配置自动发布
- `beta` 建议进入待审批
- `release` 必须人工审批

### 7.6 Jenkins 回传构建开始

如果你希望构建审计更完整，也可以保留一个很轻量的开始回传：

`POST /api/projects/:projectKey/builds/:buildId/start`

但这个接口不负责创建 build，只负责补齐实际启动时间、agent、executor、queue 信息。

## 9. 推荐控制流

如果按“`lobster-release` 调 Jenkins”这个方向，标准控制流建议是：

1. 用户或 OpenClaw 在发布中心创建 release
2. `lobster-release` 校验版本、渠道、目标平台和 patch baseline
3. `lobster-release` 创建内部 `build` 记录
4. `lobster-release` 调 Jenkins 参数化 job
5. Jenkins 执行构建、上传产物
6. Jenkins 调 `publish` 和 `finish` 回传结果
7. `lobster-release` 生成统一 `release_manifest.json`
8. 根据渠道规则进入 `published` 或 `awaiting_approval`

这个流的好处是：

- 版本主记录只在一个系统里生成
- Jenkins build number 不再等于业务主键
- 后面接审批、回滚、重新构建会自然很多

## 10. 统一下载清单建议

这是 Checklist 里最值得优先补齐的一项，因为它会直接影响客户端更新逻辑和运营侧使用方式。

建议为每个 release 生成一个统一的 `release_manifest.json`，结构可以类似：

```json
{
  "project": "gamexpert",
  "releaseId": "rel_20260322_001",
  "version": "0.0.1",
  "channel": "beta",
  "git": {
    "branch": "main",
    "commit": "8de107b"
  },
  "build": {
    "jenkinsJob": "GameXpert_Godot_CI",
    "jenkinsBuildNumber": 28
  },
  "artifacts": [
    {
      "type": "android_apk",
      "platform": "android",
      "fileName": "GameXpert-android-apk-0.0.1-28-8de107b.apk",
      "sha256": "..."
    },
    {
      "type": "macos_zip",
      "platform": "macos",
      "fileName": "GameXpert-macos-app-0.0.1-14-8de107b.zip",
      "sha256": "..."
    },
    {
      "type": "patch_bundle",
      "platform": "patch",
      "baselineVersion": "0.0.0",
      "fileName": "GameXpert-patch-bundle-0.0.1-6-e9a162b.zip",
      "sha256": "..."
    }
  ]
}
```

关键点：

- 客户端和运营都只认这一份 manifest
- 具体存储介质可以换，但 manifest 字段尽量稳定
- 所有下载地址都从 manifest 派生，而不是靠命名规则硬猜

## 11. 存储与部署建议

### 9.1 元数据存储

第一版建议：

- SQLite 或 PostgreSQL 二选一

如果是你自己先本地跑通，SQLite 足够。
如果准备多人协作、并发审批、线上部署，直接 PostgreSQL。

我更推荐：

- 本地验证阶段用 SQLite
- 准备正式接 Jenkins 和多人使用时切 PostgreSQL

### 9.2 文件存储

不要把大文件存进 OpenClaw 扩展目录。

建议存储分层：

- 开发环境：本地挂载目录
- 预发布环境：MinIO 或 S3 兼容存储
- 生产环境：OSS / S3 + CDN

发布中心数据库里只存：

- 逻辑路径
- 下载 URL
- sha256
- size

### 9.3 服务部署

建议先做成一个独立的 custom extension 服务目录，但运行形态不要被“必须是 OpenClaw 内嵌插件”绑死。

比较稳妥的路线是：

- `extensions-custom/lobster-release` 作为代码和文档根目录
- 服务本体可以是一个轻量 HTTP 服务
- OpenClaw 负责调用它、通知它、审批它

原因：

- Jenkins 需要稳定 HTTP API
- 审批和消息适合走 OpenClaw
- 文件和数据库管理更像业务服务，不像单纯工具插件

## 12. 安全与可靠性建议

这部分必须第一版就有，不然后面补会很痛。

### 10.1 鉴权

建议分两段鉴权：

- `lobster-release -> Jenkins`：Jenkins token 或专用 API token
- `Jenkins -> lobster-release`：`HMAC-SHA256`

其中 Jenkins 回传建议都用：

- `HMAC-SHA256`
- `timestamp`
- `nonce`
- `idempotency-key`

最少校验：

- 签名正确
- 时间窗口未过期
- `idempotency-key` 未重复消费

### 10.2 幂等

建议以下接口都幂等：

- `build/start`
- `build/publish`
- `build/finish`

幂等键建议格式：

- `project:buildNumber:action`

例如：

- `gamexpert:28:start`
- `gamexpert:28:publish`
- `gamexpert:28:finish`

### 10.3 重试

建议由两边共同保证：

- Jenkins 端有限次重试
- Release Center 端幂等接收

同时在服务端落一张失败事件表或重试队列，避免“Jenkins 说失败，但服务端其实已经写入成功”的灰度状态。

## 13. OpenClaw 侧推荐能力

如果你想让这个东西真正像“发布中心”而不是“一个回调 API”，OpenClaw 这侧建议至少做下面几类能力。

### 11.1 查询类

- `/release latest gamexpert beta`
- `/release show 0.0.1`
- `/release artifacts 0.0.1`
- `/release baseline android beta`

### 11.2 审批类

- `/release approve 0.0.1 beta`
- `/release reject 0.0.1`
- `/release promote 0.0.1 release`
- `/release rollback beta`

### 11.3 通知类

- Jenkins 开始构建时发通知
- 构建失败时把日志摘要推送到指定群或频道
- 待发布审批时通知负责人
- 发布成功后自动发版本摘要

### 11.4 自动化类

后续可接 Lobster 工作流做：

- beta 自动 smoke 检查
- release 前审批链
- 发布后自动生成公告
- 回滚时自动冻结渠道并通知相关人

## 14. MVP 建议

如果按最小可上线路径，我建议分三期。

### Phase 1: 主控闭环

目标：

- 能创建 release 并主动触发 Jenkins
- 能接 Jenkins `publish` / `finish`
- 能保存 release / build / artifact / baseline
- 能生成统一 `release_manifest.json`
- 能查询某版本和某渠道当前状态

这期做完后，你已经拥有“能用的发布中心后端”。

### Phase 2: 审批与渠道

目标：

- 增加 `awaiting_approval`
- 增加 `promote` / `rollback`
- 增加渠道指针管理
- 接 OpenClaw 消息通知

这期做完后，它从“构建登记系统”升级成“发布中心”。

### Phase 3: 运营化

目标：

- Web 页面
- 下载页
- 构建趋势与失败统计
- 发布说明模板
- 权限分组和操作审计检索

这期做完后，才算完整产品化。

## 15. 我建议你现在先定的几个关键决策

在真正开写代码前，建议先拍板下面 7 件事：

1. `lobster-release` 是纯 API 服务，还是 OpenClaw 插件加 API 混合体
2. 第一版数据库是 SQLite 还是 PostgreSQL
3. 第一版产物存储是本地目录还是 MinIO
4. 第一版版本号是否只支持严格三段 `major.minor.patch`
5. 渠道是否固定为 `dev / beta / release`
6. patch 是否必须依赖 baseline manifest 才允许发布
7. `dev` 是否自动发布，`beta/release` 是否必须审批
8. 触发 Jenkins 用直接 HTTP 调用，还是先经队列层再投递
9. Jenkins 回调失败时，重试策略放 Jenkins、服务端，还是双边都做

## 16. 推荐的目录演进

当前先保留文档，后面实现时建议按这个结构扩展：

```text
extensions-custom/lobster-release/
  README.md
  docs/
    release-center-design.md
  src/
    server/
    domain/
    storage/
    openclaw/
  package.json
  openclaw.plugin.json
```

其中：

- `server/` 放 HTTP API
- `domain/` 放 release/build/artifact 状态机
- `storage/` 放 DB 和对象存储适配
- `openclaw/` 放消息通知、工具、审批入口

## 17. 结论

这件事最稳的做法，不是“让 Jenkins 带着业务状态乱跑”，而是让 `lobster-release` 成为真正的 owner，把 Jenkins 降成可替换的执行层。

我建议的路线是：

- 先做一个以 API、状态机和调度为核心的 `lobster-release`
- 让 `lobster-release` 主动触发 Jenkins
- 让 Jenkins 继续负责构建和上传
- 让 `lobster-release` 负责版本、渠道、patch 基线、manifest、审批、回滚
- 让 OpenClaw 负责通知、命令入口和后续自动化

这样分层以后，后面无论你要接 Web UI、审批流、下载站、S3/CDN，还是接更多平台包，架构都不会乱。

## 18. 下一步建议

如果继续推进，下一步最值得直接写代码的是这三项：

1. 先把版本号规则和 `versioning` 配置 schema 定下来
2. 再把 `release_manifest.json` 的正式 schema 定下来
3. 然后再把“发布中心创建构建”和 “Jenkins 回传 publish / finish” 的接口契约定下来
