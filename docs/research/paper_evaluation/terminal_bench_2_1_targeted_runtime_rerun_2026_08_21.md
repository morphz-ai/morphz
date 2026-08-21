# Terminal-Bench 2.1 Runtime 定向复测记录（2026-08-21）

## 1. 状态与用途

- 类型：Runtime 诊断性定向复测，不是正式榜单结果，也不进入论文确认性数据。
- 目的：检查正式 v1 基线之后的后台唤醒、认知轨迹闭环和 Activation Context snapshot 并发修复，能否解释或消除既有失败。
- 模型：GPT-5.6 Sol，reasoning `max`，通过既有 CLIProxyAPI 路由。
- 授权：Morphz `full_access`；该授权不绕过 Provider 服务端安全策略。
- 并发：5 个任务并行；每任务 1 次，不以单次结果估计 pass@k。
- 结果目录：`jobs/tb21-targeted-current/2026-08-21__15-32-48/`

## 2. 代码身份

- 正式 v1 Runtime 基线：`f875b93`（tag `paper-eval-runtime-v3`）。
- 当前源代码 HEAD：`591b8b13710a7677e24febe28a0d7070aa559ff3`。
- 后基线关键修复：
  - `2c74b53 fix(runtime): route durable background wakes`
  - `591b8b1 feat: close the cognition trajectory loop`
- 本次二进制另包含尚未提交的 `record_activation_context_snapshot` CAS 冲突重试修复。
- Linux Runtime 二进制 SHA-256：`ee3e385c1ddf478ee3aa4ccae344694888d53455aa619044b86b2d2ef579cf3f`。

注意：`591b8b1` 主要补齐 Agent Trajectory 导出/校验、Yao Context transaction 和 Objective 状态转换的持久化闭环；它不是通用的“模型终态收敛控制器”。本轮与 Terminal-Bench 后台任务结果回流最直接相关的修复是 `2c74b53`。

## 3. 无模型回归验证

当前代码通过：

- `live_runtime_routes_background_session_wake_through_the_dialogue_router`
- `restart_recovers_background_wake_before_following_user_signal_without_starvation`
- `interactive_physical_tool_batch_delivers_its_execution_terminal_directly`
- `delivery_reply_covers_only_the_trigger_snapshot`
- `cargo clippy -p morphz --lib -- -D warnings`
- `cargo fmt --check`

## 4. 定向真实复测结果

| 任务 | Reward | Harbor 终态 | 诊断结论 |
|---|---:|---|---|
| `sqlite-db-truncate` | 1 | 正常结束 | 旧数据中曾因 Activation Context snapshot revision 冲突被 Runtime 终止；本次通过，验证 CAS 重试修复覆盖了该故障路径。 |
| `gpt2-codegolf` | 1 | 正常结束 | 后台结果回流后 Agent 继续工作并主动结束；证明 durable background wake 修复在真实任务上生效。 |
| `raman-fitting` | 1 | `AgentTimeoutError` | 后台任务成功后 Runtime 立即产生 `background_output_*`、创建新 Activation 并继续模型调用；最终产物通过 verifier，但 Agent 未在 900 秒内声明终态。结果回流已修复，终态收敛仍有问题。 |
| `qemu-alpine-ssh` | 0 | `AgentTimeoutError` | 后台事件持续回流，不是 trajectory 丢失。Apple Silicon 上的 amd64 容器通过 Rosetta 运行 QEMU 时遭遇未实现的 syscall 282；Agent 花费约 6 分钟构造兼容 shim，随后 TCG 启动 Alpine。首版 Expect 脚本没有响应串口的 ANSI `ESC[6n` 光标位置查询，虽已登录 root shell，却未识别提示符并未执行 sshd 配置。Verifier 连接到了 QEMU 的 2222 端口转发，但 guest:22 尚无 sshd，因此在密钥交换前被 reset。 |
| `extract-moves-from-video` | 0 | `AgentTimeoutError` | Agent 选择昂贵的视频抽帧/OCR 路径，后台 heartbeat 正常，但超时前未生成 `/app/solution.txt`；属于策略和时限控制问题，不是后台结果丢失。 |

诊断批次为 3/5，但该比例不具备正式统计意义。

## 5. 对既有超时的进一步归因

正式 v1 中被归为“仍在活动、耗尽时间”的代表任务，其末态数据库如下：

| 任务 | 旧基线末态证据 | 判断 |
|---|---|---|
| `compile-compcert` | 17 个 execution job 成功、1 个失败、1 个仍在运行；Thread 仍 open | 可能部分受长后台编译及唤醒链路影响，值得单独复测。 |
| `financial-document-processor` | 129 个 job 成功；最后一个 Activation 仍 running，最后事件为模型尝试状态 | 模型仍在主动循环，不是后台结果未提交。 |
| `make-doom-for-mips` | 149 个 job 成功；最后一个 Activation 仍 running | 模型/策略不收敛，不是后台唤醒丢失。 |
| `video-processing` | 442 个 job 全部成功；最后一个 Activation 仍 running | 极端工具循环和缺少终态控制；与后台结果丢失无关。 |

因此，“后台执行结果没有回到 Agent”能够解释一部分失败，但不能解释大多数长程不收敛案例。

### `qemu-alpine-ssh` 的责任边界

该失败不是 Morphz 核心 Runtime 丢失结果或错误终止，主要由以下因素共同造成：

1. 实验节点是 Apple Silicon；Terminal-Bench amd64 容器由 Rosetta 翻译，容器内的 x86_64 QEMU 又进行 TCG 模拟。QEMU 首先因 Rosetta 不支持 syscall 282 而退出，且虚拟机启动明显慢于原生 x86_64 Linux。
2. Agent 最终绕过了 syscall 问题并成功启动 Alpine 6.6.4-1-lts，但首版 Expect 串口脚本没有处理 Alpine shell 发出的 ANSI Device Status Report 查询，卡在已经出现的 `localhost:~#` 后面。
3. Agent 在超时后生成了能够处理 `ESC[6n` 的第二版脚本，但已错过 Harbor 的 900 秒 Agent deadline。
4. Harbor 判定 Agent timeout 后，Morphz 仍被后台完成事件唤醒，并继续向同一任务环境发出第二版配置命令；此时 verifier 已经开始或即将开始。这个“超时后 Agent 仍可继续变更环境”的 adapter 生命周期问题需要修复，否则会污染评测边界。不过，即使没有该问题，本次在 deadline 到达时 sshd 仍未配置好，reward 仍会是 0。
5. 第一轮环境探测中的 `command -v ssh` 被 Morphz 的 unmanaged-SSH 预检误判成了实际 SSH 连接并拒绝。`full_access` 不会绕过该独立安全规则。它只浪费了一次较短的模型回合，不是本次失败主因，但属于 Morphz shell-command 分类器需要修复的假阳性。

旧正式批次在同一 Rosetta 环境中的 5 次结果为：3 次 verifier reward=1、2 次 reward=0；其中只有 1 次在没有 AgentTimeout 的情况下干净结束。因此它不是确定性的 Runtime 回归，而是一个对宿主架构、QEMU 启动速度和串口自动化策略高度敏感的高方差任务。正式复测应优先使用原生 x86_64 Linux 节点，并修复 Harbor adapter 的取消/终态隔离。

## 6. Context snapshot 内部错误

旧实现对 `thread_activations.revision` 只进行一次 CAS。Activation lease heartbeat 或并发工具结果唤醒只要先推进 revision，就会让健康任务被错误终止为内部错误。

当前工作区修复为：

1. 重新读取最新 Activation；
2. 如果 snapshot 尚未记录且只是 revision 发生变化，最多重试 5 次并指数退避；
3. 若同一 snapshot 已提交或 Activation 已终态，则幂等成功；
4. 若已经存在不同 snapshot version，仍保留硬错误，避免掩盖真实不一致。

这属于 Runtime race condition，应该修复，不应被归为模型失败。本次 `sqlite-db-truncate` 真实复测通过，且相关单元测试、Clippy 与格式检查通过。修复目前尚未提交。

## 7. 后续最小行动

1. 为 Context snapshot revision 竞争补一个确定性回归测试后提交修复。
2. 单独复测 `compile-compcert`，确认 durable background wake 对长编译任务的影响。
3. 增加“任务已满足/Verifier 可判定完成时停止”的终态控制与预算感知，重点复现 `raman-fitting` 的 reward=1 但 Agent timeout 情形。
4. 对 `extract-moves-from-video`、`qemu-alpine-ssh` 使用轨迹做策略诊断；不要把它们继续统称为 Runtime trajectory 丢失。
5. `cyber_policy` 任务单列为 Provider 安全策略不可执行，不计作 Morphz Runtime 回归；若要纳入榜单，需要具备相应安全评测授权的 Provider 路由。
