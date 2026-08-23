# Terminal-Bench 2.1 云实验节点准备报告

> 日期：2026-08-24
> 当前节点：`8.221.120.170`（Alibaba Cloud Linux 4，Linux/AMD64，OpenAI 支持地区）
> 历史节点：`8.130.91.128`（中国大陆出口，已由当前节点替代）
> 状态：`provider-authenticated / online-preflight-passed / ready-for-real-pilot`

## 结论

海外实验节点已经完成基础设施迁移、固定构建产物复核、Codex 设备授权和在线
Provider 预检。CLIProxyAPI 当前发布精确物理模型 `gpt-5.6-sol`；Terminal-Bench
正式 `preflight` 已同时核对 Harbor、Docker、Linux Runtime、等待器、模型、
`reasoning_effort=max` 与 `full_access`，结果全部通过。

固定 5 题 Pilot 环境为 5/5 安装完成、0 错误；Harbor adapter 测试 7/7 通过；89 题
官方数据集与所需基础镜像均已缓存。本报告之前记录的中国大陆 Provider 地域阻塞已由
节点迁移解决。当前尚未在新节点调用模型、执行 verifier 或产生新成绩；下一步只能在
用户明确授权后运行 5 题、每题 1 次的真实 Pilot。

## 固定身份

| 项目 | 固定值 |
| --- | --- |
| Runtime tag | `paper-eval-runtime-v4` |
| Runtime commit | `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| 当前实验基础设施 commit | `30a9f1fae1aebc155a550eededbb9bd9ccb39d88` |
| Linux Runtime SHA-256 | `f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67` |
| Runtime watcher SHA-256 | `d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063` |
| Harbor | `0.21.0` |
| Terminal-Bench | `2.1`，官方 registry digest `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| Docker Engine | `24.0.9` |
| Docker Buildx / Compose | `0.36.1` / `v2.40.3` |
| CLIProxyAPI | `7.2.140` / commit `a7e3596b` |
| 目标模型 | `gpt-5.6-sol` / `max` / no fallback |

Runtime 构建已修正为显式注入完整源码 commit，二进制自身报告
`morphz 0.1.0 (git 5e4b0ffcd89245f19d84ec3569605ae27a44e02b)`；在相同输入下进行
第二次独立导出，SHA-256 完全一致。此前因 Docker 构建上下文不含 `.git`、且复用旧
Cargo target 而得到的 `960a7d...` 产物已标记为 superseded，不得用于新实验。

## 节点与隔离

- 16 vCPU、61 GiB 内存、197 GiB 系统盘，准备完成后约 182 GiB 可用；
- CLIProxyAPI 仅监听 Docker host bridge `172.17.0.1:8317`，不监听公网地址；
- 云安全组按用户确认只开放 TCP 22；Benchmark 容器通过 bridge 访问 Provider；
- `/etc/morphz-benchmark/provider.env` 为 root-only，日志和命令行不输出 API key；
- 每个 Trial 使用独立 Harbor 容器、SQLite、Context 和 Session；Morphz 授权模式为
  `full_access`，但不改变 Terminal-Bench 自身的任务、网络和 verifier 规则；
- 长运行使用 `morphz-benchmark@.service` 托管并持有节点级文件锁，避免 SSH 断线终止
  实验或误启动两个正式批次。

## 无模型门禁证据

### 数据集、镜像和 adapter

- 官方 Terminal-Bench 2.1 数据集：89/89 个任务 digest 已缓存；
- 7 类任务基础镜像和固定 5 题 Pilot 预构建镜像已缓存；
- `python -m unittest discover -s benchmarks/harbor/tests -v`：7 passed，0 failed；
- 覆盖 ATIF-v1.7 投影、云端 Provider 路由、Runtime 身份、任务过滤、取消传播和
  Linux `/proc` 收口。

### 5 题 Pilot install-only

冻结任务：

1. `git-multibranch`
2. `db-wal-recovery`
3. `polyglot-rust-c`
4. `financial-document-processor`
5. `cancel-async-tasks`

海外节点安装门禁目录：
`/opt/morphz-benchmark/install-only-jobs/2026-08-24__02-04-33/`。

结果为 5 completed、0 errored、0 retry；systemd 结果为 success。结果文件 SHA-256：
`ed37e5a9e32a830eaa300be41617af8bdb250277791a674af28067abc9f47eb8`。

### Provider 授权与模型目录

设备授权在当前海外节点完成，授权文件由 CLIProxyAPI 运行用户持有。服务恢复后：

- `cliproxyapi.service`：active；
- `/v1/models`：HTTP 200，共发布 10 个模型；
- 精确模型 `gpt-5.6-sol`：present；
- Provider endpoint 仍为 Docker bridge 地址，没有新增公网监听；
- 凭据未写入仓库、fixture、trace 或本报告。

### Terminal-Bench 正式 preflight

通过 systemd 执行 `morphz-benchmark@preflight.service`，退出状态 0：

```text
preflight=passed
harbor=0.21.0
model=gpt-5.6-sol
reasoning_effort=max
provider_node=172.17.0.1
provider_ipv4=172.17.0.1
permission_mode=full_access
container_platform=linux/amd64
runtime_sha256=f98c17bcc3204216aa39b3833994ad01da45c3015e02216eeb12a9290dd99e67
watcher_sha256=d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063
```

该门禁只读取模型目录并检查本地执行身份，没有发送推理请求或消耗模型额度。

## 历史中国区节点

`8.130.91.128` 曾完成 89 题数据集缓存、adapter 7/7 和 5 题 install-only，但其
中国大陆公网出口在 Codex device-code 请求阶段收到
`403 unsupported_country_region_territory`。该记录保留为基础设施历史，不再作为
当前实验节点状态。当前海外节点已经独立具备数据集、镜像、Runtime、Provider 和
systemd runner，因此正式实验不再依赖旧节点。

## 后续 Gate

1. 经用户明确授权，只运行 5 题、每题 1 次的真实 Pilot；
2. 审查五条完整 trajectory、Runtime event store、失败归因、token usage 和
   verifier 输出；
3. 若 Pilot 暴露 Runtime 或 adapter 回归，先修复、提升基线并重新执行 Pilot；
4. Pilot 无基础设施回归后，再由用户决定启动 89 题单次诊断批次，或冻结后执行
   89 × 5 的公开协议批次。

当前状态：`real_model_smoke_permitted=true / real_model_smoke_started=false`。
