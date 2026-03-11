---
name: openclaw-version-bump
<<<<<<< Updated upstream
description: OpenClaw 仓库版本同步技能。统一查看/更新核心版本号文件，支持 dry-run 预览与批量写入。
metadata:
  {
    "openclaw": { "emoji": "🛠️", "requires": { "bins": ["python3"] }, "notes": ["仅在仓库内执行"] },
  }
=======
description: Check local and remote OpenClaw versions.
metadata: '{ "openclaw": { "emoji": "⬆️" } }'
>>>>>>> Stashed changes
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
disable-model-invocation: true

user-invocable: true
---

<<<<<<< Updated upstream

# OpenClaw 版本更新 Skill

用于 OpenClaw 仓库内的版本同步。这个 skill 只做版本号落盘，不做发布/打包动作。

## 什么时候用

你要做以下事情时直接用这个 skill：

- 批量查看当前关键版本文件现状
- 统一更新 `release` 版本号
- 先预览修改再执行落库，避免手工遗漏

## 目录结构（清晰分层）

- `SKILL.md`：触发与使用说明
- `references/version-locations.md`：受控版本文件清单
- `scripts/openclaw-version-bump.py`：版本读取 + 变更执行脚本

## 快速开始

先看当前值：

```bash
{baseDir}/scripts/openclaw-version-bump.py show
```

预览提案（不落库）：

```bash
{baseDir}/scripts/openclaw-version-bump.py bump 2026.3.4 --android-version-code 202603040 --dry-run
```

执行更新（写入文件）：

```bash
{baseDir}/scripts/openclaw-version-bump.py bump 2026.3.4 \
  --android-version-code 202603040 \
  --ios-build 202603040 --ios-test-build 202603040 --mac-build 202603040 \
  --yes
```

更新到指定仓库版本（含 tag）：

```bash
{baseDir}/scripts/openclaw-version-bump.py upgrade 2026.3.8
```

查最新版本（远端 origin）：

```bash
{baseDir}/scripts/openclaw-version-bump.py latest
```

返回示例：

```text
latest_version=v2026.3.8
latest_version_without_prefix=2026.3.8
```

说明：

- 查询逻辑会按顺序尝试：
  1. 本地 tag
  2. `origin`（或环境变量 `OPENCLAW_GITHUB_REPO_URL` 指定的仓库）
  3. GitHub API 公共接口 `https://api.github.com/repos/openclaw/openclaw/tags`
  4. 兜底到 `package.json` 里的 `version`

如果你的输出里出现“using package.json version as fallback”，说明 1~3 层都拿不到，通常是运行环境网络或 git remote 不可达导致的。

说明：

- 如果本地和远端标签都暂时不可用，脚本会退回到 `package.json` 的 `version` 作为兜底值，以保证命令可用。

可选切回并更新某个分支：

```bash
{baseDir}/scripts/openclaw-version-bump.py upgrade 2026.3.8 --branch main
```

## 约定说明

- `bump` 的第一个参数是统一 release 版本号。
- 默认安卓/iOS/mac 短版本默认同 `--version`，也可通过独立参数覆盖。
- `--dry-run` 只打印 diff，不写文件。
- `--yes` 用于非交互执行；未传时会要求确认。
- 版本文件范围见 `references/version-locations.md`。
- 本 skill 默认不改 `appcast.xml`。

推荐调用方式：

- 作为 Slash Command（推荐）：`/openclaw_version_bump bump 2026.3.4 --yes`
- 查看版本（推荐）：`/openclaw_version_bump show`
- 更新本地仓库到指定版本：`/openclaw_version_bump upgrade 2026.3.8`
- 一键查询最新版本：`/openclaw_version_bump latest`
- 如返回来自本地 `package.json` 兜底版本，结果中会有对应提示文本。
- 常见步骤：先查最新再升级：`/openclaw_version_bump latest` -> 取 `latest_version_without_prefix` -> `/openclaw_version_bump upgrade <version>`
- 兼容写法（若有需要）：`/openclaw_version_bump openclaw-version-bump show`
- 直接执行（避免依赖 PATH）：`/Users/pengwang/Documents/GitHub/OpenClaw/extensions-custom/skills/openclaw-version-bump/openclaw-version-bump`

如果你看到 `command not found`，通常是因为这个执行环境不在当前 PATH。请优先使用 `openclaw` 作为入口，它会自动兼容并转发到版本脚本：

```bash
{baseDir}/openclaw bump 2026.3.4 --yes
```

```bash
{baseDir}/openclaw show
```

## 常见参数

```bash
{baseDir}/scripts/openclaw-version-bump.py bump <version> [options]
```

### 核心参数

- `--android-version-name`
- `--android-version-code`
- `--ios-version`
- `--ios-build`
- `--ios-test-build`
- `--mac-build`
- `--dry-run`
- `--yes`

## 安全边界

- 未匹配到目标文件/字段会直接报错，不会静默跳过。
- # 不能解析目标版本文件时会退出，避免写坏仓库状态。

# OpenClaw Version Bump

用于查看当前仓库版本与远端最新可用版本。

默认执行：读取本地 `package.json` 版本与 git 标签最新版本。

## 命令

- `/openclaw_version_bump` 仅查询（默认）
- `/openclaw_version_bump latest` 显示远端最新版本
- `/openclaw_version_bump current` 显示本地版本
  > > > > > > > Stashed changes
