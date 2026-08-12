---
title: CLI 参考
description: Morphz 顶层命令、常用诊断入口与帮助发现方式。
section: reference
order: 400
status: current
---

CLI Schema 由代码中的 Clap 定义生成。当前二进制的 `--help` 是参数和子命令的最终权威来源。

## 直接对话

不带子命令的文本会直接发送给 Agent：

```bash
morphz 请检查当前项目
morphz -- 请把 setup 当作普通提示词处理
```

`--` 强制其后的内容作为 Prompt，避免与命令名冲突。

## 顶层命令

| 命令 | 用途 |
|---|---|
| `exec` | 执行一次明确的 Agent 请求 |
| `resume` | 恢复已有 Session |
| `serve` | 启动 HTTP、WebSocket 与 Dashboard |
| `dashboard` | 启动 Dashboard 并打开浏览器 |
| `setup` | 打开模型配置向导 |
| `provider` | 管理服务实例和认证账号 |
| `model` | 管理与测试模型路由 |
| `context` | 管理 Context、认知与 Recall |
| `session` | 创建、列出、恢复和归档 Session |
| `objective` | 管理持久目标 |
| `scheduler` | 查看和控制调度状态 |
| `job` | 查看后台工作 |
| `edge` / `target` / `execution` | 管理执行节点与目标 |
| `config` | 检查最终配置及来源 |
| `doctor` | 运行整体诊断 |
| `completion` | 生成 Shell 补全 |

## 获取准确帮助

```bash
morphz --help
morphz help provider
morphz provider account --help
morphz context recall search --help
```

界面语言由 `[ui].language`、`--language` 或 `MORPHZ_LANGUAGE` 控制，可设置 `auto`、`en` 或 `zh-CN`。

## 脚本输出

管理命令通常支持 `--format=json`。自动化应使用 JSON 字段和稳定 ID，不要解析面向人的表格或翻译文本。
