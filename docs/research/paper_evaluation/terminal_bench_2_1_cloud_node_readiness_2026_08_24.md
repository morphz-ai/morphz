# Terminal-Bench 2.1 云实验节点准备报告

> 日期：2026-08-24  
> 节点：`8.130.91.128`（Alibaba Cloud Linux 4，Linux/AMD64）  
> 状态：`infrastructure-ready / awaiting-provider-device-login`

## 结论

云节点已经完成不调用模型的基础设施门禁。固定的 5 题 Pilot 环境全部安装成功，
Harbor adapter 全量测试 7/7 通过，89 题官方数据集已经缓存，Runtime、等待器、
Harbor、Docker、Compose 和 CLIProxyAPI 的身份均已核对。当前唯一未完成的必要门槛
是 CLIProxyAPI 的 Codex 设备登录，以及登录后对物理模型 `gpt-5.6-sol`、
`reasoning_effort=max` 和 `fallback=false` 的在线预检。

本轮没有调用模型、没有执行 verifier、没有产生可报告 Benchmark 分数，也没有消耗
模型额度。

## 固定身份

| 项目 | 固定值 |
| --- | --- |
| Runtime tag | `paper-eval-runtime-v4` |
| Runtime commit | `5e4b0ffcd89245f19d84ec3569605ae27a44e02b` |
| 实验基础设施 commit | `b59a357f736b2ff25b565d9152694b2629ff5d43` |
| Linux Runtime SHA-256 | `960a7d49089969bb0bbd6517307561fa2d83fd5a4bad68856b47fc8a75eb68ac` |
| Runtime watcher SHA-256 | `d41c6c5789421d0b957d78269d886a638c1def323b8b2098763fbfadee8f9063` |
| Harbor | `0.21.0` |
| Terminal-Bench | `2.1`，官方 registry digest `sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a` |
| Docker Engine | `24.0.9` |
| Docker Compose | `v2.40.3` |
| CLIProxyAPI | `7.2.140` / commit `a7e3596b` |
| 目标模型 | `gpt-5.6-sol` / `max` / no fallback |

## 节点与隔离

- 16 vCPU、61 GiB 内存、197 GiB 系统盘；准备结束时约 176 GiB 可用；
- CLIProxyAPI 仅监听 Docker host bridge `172.17.0.1:8317`；不监听公网地址；
- 云安全组按用户确认只开放 TCP 22；Benchmark 容器通过 bridge 访问 Provider；
- `/etc/morphz-benchmark/provider.env` 为 root-only，日志和命令行不输出 API key；
- 每个 Trial 使用独立 Harbor 容器、SQLite、Context 和 Session；Morphz 授权模式为
  `full_access`，但不改变 Terminal-Bench 自身的任务、网络和 verifier 规则；
- 长运行使用 `morphz-benchmark@.service` 托管并持有节点级文件锁，避免 SSH 断线终止
  实验或误启动两个正式批次。

## 中国区网络路径

- Docker Hub 拉取使用 `docker.1ms.run` 和 `docker.m.daocloud.io` registry mirror；
- Rustup 与 Cargo 使用 RSProxy；工具链版本、Cargo.lock 与最终二进制哈希仍固定；
- 5 个 Pilot 预构建镜像和 7 类任务基础镜像均已缓存；
- 没有为“看起来更完整”而预拉取所有 89 个大型预构建镜像。剩余镜像在真实批次按需
  获取，避免在当前准备阶段浪费中国区跨境网络时间。

## 无模型门禁证据

### Adapter

云节点执行 `python -m unittest discover -s benchmarks/harbor/tests -v`：

- 7 passed，0 failed；
- 覆盖 ATIF-v1.7 投影、云端 Provider 路由、Runtime 身份、任务过滤、取消传播和
  Linux `/proc` 收口；
- `test_quiesce_preserves_service_and_kills_transient_child` 连续执行时暴露的
  `/proc/<pid>/stat` TOCTOU 已在基础设施 commit `b59a357` 修复；此前定向重复
  20/20 通过，本次全量复核再次通过。

### 5 题 Pilot install-only

冻结任务：

1. `git-multibranch`
2. `db-wal-recovery`
3. `polyglot-rust-c`
4. `financial-document-processor`
5. `cancel-async-tasks`

第二次安装门禁目录：
`/opt/morphz-benchmark/install-only-jobs/2026-08-24__01-18-48/`。

结果为 5 completed、0 errored、0 retry。中途本地 SSH 连接断开，但云端 Harbor 进程
继续执行并完成，服务器没有重启、没有 OOM。最后一个 `git-multibranch` 因镜像 mirror
出现一次 `unexpected EOF` 自动续传，最终成功。Harbor `install-only` 的顶层
`result.json` 保留 `finished_at=null`，但五个子 Trial 均有最终时间、无异常，父进程已
退出；该字段不作为模型运行或成绩证据。

第一次目录 `/opt/morphz-benchmark/install-only-jobs/2026-08-24__01-14-01/`
因缺少 Docker Compose plugin 失败，保留为基础设施失败记录；安装并校验
Compose v2.40.3 后才执行上述成功门禁，失败尝试不会混入任何成绩。

## 后续 Gate

1. 进行一次 Codex device login，重启 CLIProxyAPI；
2. 运行在线 `preflight`，确认 API 实际广告并接受精确物理模型
   `gpt-5.6-sol`，不允许别名漂移和 fallback；
3. 经用户明确授权后，只运行 5 题、每题 1 次的真实 Pilot；
4. 审查五条完整 trajectory、Runtime event store、失败归因、token usage 和
   verifier 输出；
5. Pilot 无基础设施回归后，再由用户决定是否启动正式 89 题单次诊断批次或
   89 × 5 的公开协议批次。

设备登录和在线预检完成前，`real_model_smoke_permitted=false`。
