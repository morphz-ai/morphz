# ME-07 云端正式执行交接记录（2026-08-26）

> 状态：`local-training-complete / local-artifacts-uploaded / runtime-release-r3-passed / cloud-finalizer-active / formal-not-started`
>
> 协议：`ME-07-STATE-Bench-public-agent-systems-v2`

## 目的

ME-07 包含 3 个系统、3 个领域、每领域 100 条训练轨迹，以及
`3 arms × 150 held-out tasks × 5 runs = 2,250` 个正式 trial。为避免移动工作站休眠、
断网或被带离现场后中断正式批次，训练只在完整领域边界迁移，全部 smoke、正式评分、统计和
人工复核包生成均转移到独立 Linux 云节点。

## 冻结身份

- Runtime adapter commit：`2e502056f52fc355e29f01df69d3b434607c257e`；
- Runtime 收敛基线：`ad60e300f115fe84e03a8cd3ab70940deb06ae68`；
- Linux 正式 Runtime commit：`2249878536ce5f7a8d7449add2f5c8743395b69b`；
- Darwin/arm64 训练二进制：
  `0666fd3c0e49b2365d923d9589229ed6e37d6d47bbabc6bfcf0e0a45d53fa31a`；
- Linux/x86-64 正式二进制：
  `7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e`；
- STATE-Bench commit：`5644b1838d96bc4483da29642d058ecaa6f80f7f`；
- Letta：v0.16.8，source commit
  `1131535716e8a31c9a437f8695e25ac98f203a24`；
- Mem0：v2.0.19，source commit
  `dc82354e143c2581d505d581a00286d6ef8c3605`；
- 模型：CLIProxyAPI Responses 上精确物理 `gpt-5.6-sol`、`max`、单候选、
  `fallback=false`；
- embedding：Ollama `nomic-embed-text:latest`，768 维；
- PostgreSQL：15.16；正式节点：Linux/x86-64、16 logical CPU、约 64 GiB RAM。

## 训练与迁移边界

已经开始的领域不从半成品继续，也不拼接两台机器的同一份状态：

| 系统 | travel | customer_support | shopping_assistant |
| --- | --- | --- | --- |
| Morphz | Darwin 从 1 跑到 100 | Linux 从 1 跑到 100 | Linux 从 1 跑到 100 |
| Letta | Darwin 从 1 跑到 100 | Darwin 从 1 跑到 100 | Darwin 从 1 跑到 100 |
| Mem0 | Darwin 从 1 跑到 100 | Linux 从 1 跑到 100 | Linux 从 1 跑到 100 |

所有快照须先得到 `episode_count=100`、`passed=true` 的训练 receipt；Morphz 还必须完成
SQLite backup/reload 状态等价检查，Letta 必须完成导出快照与原子 checkpoint 的一致性检查
并在正式批次前由 scored smoke 重新导入，Mem0 必须正常关闭持久 vector store。随后由一次性 assembly 程序复制到新的不可覆盖目录，
生成各快照哈希、生产环境映射、Python freeze、容器镜像 ID、源码 commit 与执行脚本哈希。

## 云端服务

- `morphz-me07-proxy-loopback.service`：只监听 loopback 的模型代理入口；
- `morphz-me07-letta.service`：Letta 0.16.8，持久 PostgreSQL 后端；
- `morphz-me07-ollama`：固定 Ollama 0.5.4 容器；
- `morphz-me07-postgres`：固定 pgvector/PostgreSQL 容器；
- `morphz-me07-train-morphz-remaining-20260826.service`：剩余 Morphz 领域；
- `morphz-me07-train-mem0-remaining-20260826.service`：剩余 Mem0 领域；
- `morphz-me07-finalize-and-start-20260826.service`：等待云端训练、正式 Runtime 发布门和 ME-08
  释放节点，汇总快照并启动正式服务；
- `morphz-me07-formal-20260826.service`：正式 smoke、2,250 trials、统计与盲评包。

访问凭据不出现在命令行、systemd unit、manifest 或本文档中；执行包装器仅在进程内从云端已有
CLIProxyAPI 配置读取唯一 access key。

## 自动交接 Gate

一次性 macOS LaunchAgent 只负责保持本机训练期间系统唤醒、校验并上传已经在本机开始的完整
领域。上传闭合后，它启动云端 finalizer 即可退出；此后的等待、汇总、smoke 和正式运行不再依赖
笔记本。两级交接按以下条件推进：

1. 本机 Morphz travel、Letta 三领域、Mem0 travel receipt 全部通过；
2. 本机产物上传到新建且不可覆盖的 staging 目录；
3. 本机启动并确认云端 finalizer 已由 systemd 接管；
4. 云端 finalizer 等待 Morphz/Mem0 两条剩余领域训练序列完整结束；
5. ME-08 暴露的 terminal commit—delivery 竞态已经修复，并通过新增回归、Linux release
   build、无模型 Gate；finalizer 只接受包含 Runtime/adapter commit、二进制 SHA-256 和协议
   revision 的显式 release receipt，不允许静默沿用旧二进制；
6. ME-08 Terminal-Bench 节点负载已经释放；
7. assembly manifest 和 environment lock 生成成功；
8. 云端三臂同题 smoke 通过；
9. formal runner 校验 Linux Runtime 哈希、STATE-Bench commit、三领域九份快照和冻结队列。

formal runner 的每个 terminal failure 都保留并计零。进程中断时只恢复缺失 job；已经形成原子
job receipt 的失败绝不重跑，已经写出 trajectory 而未写出 receipt 的窄窗口按 orphan failure
处理。正式完成后自动生成聚类 bootstrap、paired sign-flip、Holm 校正结果，以及 30 条、双人
独立盲评所需的数据包；盲评人工填写本身仍需后续完成。

## 启动前验证

- Linux Runtime 无模型 Gate：通过；
- 本地 STATE-Bench adapter/test suite：`21 passed`；
- cloud pipeline/assembly/training 脚本：Python bytecode compilation 通过；
- Letta health、PostgreSQL、Ollama、proxy loopback：健康；
- 正式服务在快照汇总前保持 `disabled/inactive`，不会误用半成品状态。

## 实际交接结果

2026-08-26 22:04（Asia/Shanghai），本机边界已经闭合：Morphz travel 训练达到
100/100 且 receipt `passed=true`，Letta 三个领域和 Mem0 travel 的完整领域 receipt 也均已
通过。一次性交接程序向云端不可覆盖 staging 目录上传 16 个显式文件（约 34 MiB），随后启动
并确认 `morphz-me07-finalize-and-start-20260826.service` 为 active。macOS LaunchAgent 以
exit code 0 退出并已卸载，因此从这一时刻起，云端剩余训练、快照组装、smoke、正式批次、
统计与盲评包生成均不依赖本机保持在线。

交接完成时，云端 Morphz 与 Mem0 的剩余领域训练服务均为 active；formal 服务保持 inactive
是预期状态。22:32，finalizer 已升级为显式 Runtime release Gate：即使训练和 ME-08 均结束，
只要 post-ME-08 修复尚未取得有效 release receipt，它也不会使用旧二进制启动正式批次。该
安全 Gate 的脚本 SHA-256 为
`eb4129efbfdf7381a575f994ca09f74fc8bcc9695b3e91885ab75084a30bb667`，升级过程没有中断两条
训练服务。正式批次将在新 Runtime 通过发布 Gate、九份快照通过 assembly Gate 且节点释放后
由 finalizer 启动。

23:03 前，release Gate 已闭合：adapter 与通用修复合并 commit 为 `2249878`，Linux binary
SHA-256 为 `7b0c63cd685f4b4420f362bea1f986fa4546ad27482802aec5af3c9cbdbb356e`。本机组合分支
通过 Morphz lib 1004 项和 Evals 87+3 项测试；云端无模型 Gate 进一步验证一次且仅一次
durable reply、`thread_outcomes.delivered_at` 非空、进程退出后可立即重新取得 SQLite
`BEGIN IMMEDIATE` 写事务，且 model calls 为 0。machine-readable release receipt
SHA-256 为 `95e339110a085b03e7166f11353020a50909270f42b331fd937fc6bd234ff072`。finalizer 已可读取
该 receipt，但仍按顺序等待两条训练服务闭合；发布门没有中断或改写正在形成的训练快照。
