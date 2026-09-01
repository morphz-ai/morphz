# Morphz Edge Bootstrap v1

> 状态：实现基线  
> 更新时间：2026-09-01  
> 目标：用一条短期 Bootstrap 命令完成官方 Edge 构建的下载、验证、配对和用户级常驻运行

## 1. 产品入口

macOS/Linux 用户从 Morphz 网站复制：

```bash
curl -fsSL https://morphz.ai/edge/install | sh -s -- --code pair_xxx --workspace "$PWD"
```

Windows 用户复制等价 PowerShell 命令。命令中的 `pair_xxx` 是最长 900 秒、一次性使用的 Bootstrap Code，不是网站 Session、Runtime operator token 或 Edge 长期设备凭证。

## 2. 安全不变量

1. 安装脚本只从官方 HTTPS Release Manifest 下载固定版本构建；
2. 构建必须同时通过 SHA-256 与发布签名校验；
3. Bootstrap Code 不进入 URL query、下载日志或安装产物；
4. 设备 Ed25519 私钥只在本机生成和保存；
5. 默认 Workspace 受限，Full Access 必须显式指定并显示风险；
6. 安装默认不要求管理员权限，使用用户目录与用户级后台服务；
7. 重复执行相同 Code 必须失败，不覆盖已有有效设备身份；
8. 安装失败必须可重试、可诊断且不留下半注册的后台服务。

## 3. 分层

`morphz-edge` 核心新增一个稳定的非交互 Bootstrap 入口，但不负责下载自身：

```text
morphz-edge bootstrap
  --server-url URL
  --pairing-code CODE
  --workspace PATH
  [--node-name NAME]
  [--workers COUNT]
```

它完成：

1. 生成并保存设备身份；
2. 调用现有 pair 协议；
3. 验证本地配置与 Workspace policy；
4. 输出结构化 installation receipt；
5. 在 `--foreground` 时直接运行，或为平台安装器提供稳定的 `run` 参数。

平台脚本负责：

- 检测 OS/architecture；
- 获取并验证 Release Manifest/构建；
- 安装到用户目录；
- 注册 launchd/systemd --user/Windows user task；
- 启动服务并等待 `morphz-edge status`/Cloud Node online；
- 安装、升级和卸载 receipt。

## 4. Release Manifest

```json
{
  "schema_version": 1,
  "version": "0.1.0",
  "published_at": "RFC3339",
  "artifacts": [
    {
      "platform": "macos",
      "architecture": "aarch64",
      "url": "https://...",
      "sha256": "...",
      "signature": "...",
      "size_bytes": 0
    }
  ]
}
```

Manifest 自身必须签名；客户端/脚本内置发布公钥。URL 可以指向 GitHub Releases 或 R2，但协议不得依赖某一厂商。

## 5. 本地布局

默认用户级布局：

```text
~/.local/bin/morphz-edge                 Linux/macOS binary（平台可覆盖）
~/.morphz/edge/credentials.json          设备身份
~/.morphz/edge/bootstrap-receipt.json    安装与版本 receipt
~/.morphz/edge/service.*                 后台服务配置/状态引用
```

macOS 使用 `~/Library/LaunchAgents`，Linux 使用 `systemd --user` 并提供无 systemd 降级说明；Windows 使用用户级后台启动机制。服务不保存 Bootstrap Code，只保存配对后生成的设备凭证与非秘密运行配置。

## 6. 失败与回滚

- 下载/校验失败：不替换当前二进制；
- pair 失败：不注册服务，保留可安全覆盖的临时文件；
- 服务注册失败：撤销新服务文件，不删除已有设备凭证；
- Cloud online 超时：服务保持可诊断状态，打印日志位置和重试命令；
- uninstall 默认删除服务和二进制；是否删除设备凭证需单独确认，Cloud Node 撤销由网站完成。

## 7. 验收

- macOS arm64、Linux arm64/x86_64、Windows x86_64 一条命令安装；
- 代码过期、重放、错误平台、校验失败、离线重试均 fail closed；
- 服务随用户登录自动启动，断网恢复后重新连接；
- Workspace 外访问被 Sandbox/permission policy 拒绝；
- Cloud 撤销 Node 后旧设备凭证无法继续 claim Job；
- 卸载后无残留运行进程，凭证保留/删除行为与用户选择一致。
