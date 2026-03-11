---
name: openclaw-restart
description: Restart OpenClaw Gateway (foreground gateway runner wrapped in background) so config changes can take effect immediately.
metadata: '{ "openclaw": { "emoji": "🔁", "requires": { "bins": ["bash", "node"] } } }'
command-dispatch: tool
command-tool: exec
command-arg-mode: raw
disable-model-invocation: true

user-invocable: true
---

# OpenClaw 重启 Skill

用于重启 OpenClaw Gateway 的统一入口，适合你在修改配置后，
让 gateway 重新加载新配置。

可通过斜杠命令触发（命令名会被标准化为 `/openclaw_restart`）：

- `/openclaw_restart`

## 行为说明

执行 `openclaw_restart` 会按如下顺序处理：

1. 先尝试 `gateway stop`。
2. 再兜底清理当前配置端口的监听进程（默认 18789）。
3. 在后台启动 `gateway run --force`。

默认使用仓库内 CLI 与配置：

- 入口：`./openclaw.mjs`
- 默认配置：`configs/openclaw.json`（如果不存在会回退到 `~/.openclaw/openclaw.json`，或优先读取 `OPENCLAW_CONFIG_PATH`）

## 快速命令（按执行体 `openclaw_restart`）

- 重启（默认）：

```bash
/openclaw_restart
```

- 显式重启：

```bash
/openclaw_restart restart
```

- 停止：

```bash
/openclaw_restart stop
```

- 启动：

```bash
/openclaw_restart start
```

- 查看状态：

```bash
/openclaw_restart status
```

## 常用参数

- `--config <path>`：指定配置文件路径
  （默认：`configs/openclaw.json` 或 `~/.openclaw/openclaw.json`）。
- `--log <path>`：指定 gateway 重启日志路径
  （默认：`~/.openclaw/openclaw-gateway-restart.log`）。
- `--help`：显示脚本用法。

## 注意事项

- 该 skill 不要求你在系统 PATH 中有 `openclaw` 全局命令。
- 命令会尝试使用 `node openclaw.mjs` 执行本仓库本地 CLI，
  避免 `command not found` 的问题。
- `start`/`restart` 使用 `--force`，会清理占用目标端口的监听。
