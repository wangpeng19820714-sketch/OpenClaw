---
name: openclaw_update
description: Update OpenClaw CLI to the latest version (official command) via local repository binary.
metadata: '{ "openclaw": { "emoji": "📦", "requires": { "bins": ["bash", "node"] } } }'
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
disable-model-invocation: true

user-invocable: true
---

# OpenClaw Update Skill (Alias)

用于调用官方的 `openclaw update`，在不要求全局 PATH 的前提下使用本仓库本地 CLI。
`/openclaw_update` 会走这个别名入口。

会创建一个可被调用的技能命令：

- `/openclaw_update`

## 行为说明

执行该命令等价于在仓库根目录运行：

```bash
OPENCLAW_CONFIG_PATH=configs/openclaw.json node openclaw.mjs update
```

默认会执行更新检查并按官方流程升级（不会注入自定义版本脚本逻辑）。

## 快速命令

- 直接执行更新：

```bash
/openclaw_update
```

- 查看帮助：

```bash
/openclaw_update --help
```

## 说明

- 优先使用仓库内的 `openclaw.mjs`，避免 `openclaw` 命令不存在导致的执行失败。
- 需要 `node` 可用；建议在 `tools.exec.pathPrepend` 中保持你自己的 PATH 习惯（可选）。
- 该技能默认会读取 `configs/openclaw.json`，若不存在则回退 `~/.openclaw/openclaw.json`，可通过环境变量覆盖 `OPENCLAW_CONFIG_PATH`。
- 在终端直接执行时请使用 `openclaw_update`（前导 `/` 在 shell 中会被当成绝对路径，通常会报 `no such file`）。
- 在 OpenClaw 消息里可触发 `/openclaw_update`（由技能分发层解析后的实际命令是 `openclaw_update`）。
