# Morphz 与具身智能：双求值器在物理世界中的长期远景

> 状态：长期研究远景 v1，不代表当前产品路线已经转向机器人
> 日期：2026-07-26
> 适用范围：具身智能、机器人认知架构、物理 Execution Target、持续感知、异步调度、Yao / S-Expression、Frame 与安全控制
> 相关文档：[`morphz_dual_evaluator_symbolic_machine.md`](morphz_dual_evaluator_symbolic_machine.md)、[`morphz_execution_target_and_edge_node_architecture_v1.md`](morphz_execution_target_and_edge_node_architecture_v1.md)、[`morphz_frame_vm_model_cognition_decoupling.md`](morphz_frame_vm_model_cognition_decoupling.md)、[`morphz_reality_constrained_epistemic_context.md`](morphz_reality_constrained_epistemic_context.md)

## 1. 文档目的

Morphz 最初并不是以机器人或具身智能为目标设计的。它从长期 Agent、共享认知、多 Session、并发任务、Context 自主维护、S-Expression VM 和确定性 Runtime 逐步演化而来。

当这些结构形成之后，一个新的方向自然显现：

> **非确定性认知语义求值与确定性现实求值的交错执行，可能天然适合持续感知、持续行动、多人交互和多目标并存的具身智能。**

本文记录这一长期远景，但不作以下承诺：

- 不把当前 Morphz 产品立即改造成机器人平台；
- 不声称当前通用 LLM 已经可以安全控制真实机器人；
- 不把毫秒级运动控制交给语言模型；
- 不假设所有具身能力都应该由 S-Expression 表达；
- 不以端到端 VLA 和分层 Runtime 互相排斥。

本文要回答的是：如果未来把机器人、机械臂、车辆、传感器网络或其他物理系统作为 Morphz 的 Execution Target，现有架构哪些部分可以自然复用，哪些物理现实约束必须新增，以及这条路线与当前具身智能研究有什么本质区别。

## 2. 核心判断

Morphz 更适合被理解为未来具身系统的**认知操作系统**，而不是低层运动控制器。

它可以负责：

- 理解人的开放目标；
- 维持长期人格、关系和经验；
- 把意图组织成可求值的符号计划；
- 调度多个身体、技能和执行节点；
- 在行动、感知与人类对话之间保持因果关系；
- 根据现实 Observation 重新规划；
- 管理目标、权限、资源、时序和失败恢复；
- 记录物理副作用的证据和来源。

它不应直接负责：

- 关节伺服控制；
- 电机电流环和位置环；
- 碰撞急停；
- 硬实时稳定控制；
- 驱动器级故障保护；
- 任何不能容忍模型延迟和随机性的安全闭环。

因此更准确的分层是：

```text
持续存在的 Agent / Mind
        ↓
LLM 认知语义求值 infer
        ↓
Yao / S-Expression 语义计划
        ↓
Morphz Runtime 确定性现实求值 eval
        ↓
具身技能策略 / VLA / 导航与抓取策略
        ↓
实时控制器 / 安全控制器
        ↓
传感器与执行器构成的物理身体
```

这不是把一个聊天 Agent 接到机器人 API，而是把同一个认知主体挂载到持续产生现实 Observation、同时接受物理 Action 的 Execution Target 上。

## 3. 为什么具身智能天然需要交错求值

传统聊天式 Agent 容易把一次工作描述成线性循环：

```text
用户消息 → 模型 → 工具 → 模型 → 回复
```

真实物理系统并不服从这种线性结构。机器人在执行任务时，至少存在以下并发活动：

- 摄像头、麦克风、触觉、里程计和设备状态持续产生数据；
- 实时控制器持续维持稳定和安全；
- 当前技能正在执行；
- 高层模型可能正在规划下一步；
- 人可以随时插话、纠正或发出新目标；
- 电量、温度、网络和环境风险需要后台监测；
- 另一个身体或协作节点可能同时返回结果；
- 旧计划随世界变化而失效。

因此，具身智能的正常状态不是“一次请求尚未结束”，而是：

> **多个具有不同时间尺度、不同权威性和不同因果关系的求值过程持续并存。**

这与 Morphz 已经形成的结构高度一致：Dialogue Thread、Execution Thread、Objective、Timer、Action Group、Observation、Delivery 和 Background Process 原本就不要求共享一条串行消息链。

## 4. 从 Morphz 领域概念到具身系统的映射

| Morphz 概念 | 在具身智能中的含义 |
| --- | --- |
| Agent | 持续存在的认知主体，不等于某一台机器人 |
| Context | 当前被激活的认知、关系、世界状态与任务环境 |
| Mind / Frame | 长期经验、对象认知、环境规律、行为偏好与技能使用经验 |
| Session | Agent 与某个人、组织、设备或外部系统的 I/O 关系 |
| Thread | 一条有明确因果边界的对话、规划、执行或交付过程 |
| Objective | 跨多轮感知和行动持续存在的目标 |
| Observation | 人类消息、视觉解释、设备状态、技能结果、异常和环境事件 |
| Execution Target | 动作最终发生的机器人、机械臂、车辆、设备或仿真环境 |
| Execution Node | 承接 Target、运行本地策略、沙箱和安全控制的边缘计算节点 |
| Action Group | 一组具有共同起因、可能并行执行的物理或认知动作 |
| Event Ledger | 不可变的意图、决策、感知、行动、审批与结果证据链 |
| Projection | 从事件流得到的当前世界状态、设备状态、任务状态和认知状态 |
| Harness | 某类具身任务的执行纪律、技能组合和验证流程 |
| Yao / S-Expression | LLM 与 Runtime 共同理解的语义计划和关系结构 |

这里最重要的变化是：

> Agent 不属于某一个物理身体；物理身体是 Agent 在特定权限下可以使用的现实执行目标。

同一个 Agent 可以：

- 只拥有一个身体；
- 在不同时间迁移到不同身体；
- 同时使用机械臂、移动底盘、无人机和传感器；
- 在身体离线时继续保持认知和对话；
- 在仿真环境中先求值，再在真实 Target 上执行；
- 把不同身体产生的经验归入同一个 Mind，但保留来源和适用范围。

## 5. 具身系统中的双求值器

### 5.1 认知语义求值器 `infer`

由 LLM、VLM 或经过具身训练的模型承担，处理开放语义：

- “把桌子收拾干净”在当前环境中是什么意思；
- 哪些物品属于垃圾，哪些应被保留；
- 用户插话是否是补充、纠正、停止还是新目标；
- 当前异常意味着重新尝试、换技能还是请求帮助；
- 哪些历史 Frame 与当前场景有关；
- 多个目标之间如何协调优先级；
- 如何把自然语言目标转换成候选计划；
- 如何解释感知模型和工具返回的不完备信息。

### 5.2 确定性现实求值器 `eval`

由 Morphz Runtime 和本地控制基础设施承担，处理权威现实：

- 目标设备是否在线；
- 当前世界状态版本是否仍然有效；
- 动作前置条件是否满足；
- 用户和 Agent 是否拥有该 Target 的控制权；
- 机器人是否处于允许执行的模式；
- 资源、时间、空间和安全约束是否满足；
- Action Group、lease、fencing 和取消是否合法；
- 物理副作用已经开始、完成、失败还是结果未知；
- 新 Observation 如何原子进入 Ledger 和 Projection；
- 哪个 Thread、Objective 和 Session 应被唤醒。

### 5.3 VLA 和学习型策略属于哪一层

具身系统通常还需要视觉—语言—动作模型、强化学习策略、模仿学习策略、导航模型和抓取模型。它们在工程上是独立组件，但不必因此修改双求值器的基础理论。

可以把求值域分为：

```text
广义 infer
  ├── LLM：开放目标、计划、解释和语言交互
  ├── VLM：视觉语义与场景理解
  ├── VLA：视觉和语言到动作策略的非确定性映射
  └── 专用策略：导航、抓取、姿态或预测

广义 eval
  ├── 计划校验与 lowering
  ├── 调度、事务、权限和资源
  ├── 设备协议和技能调用
  ├── 实时安全与动作边界
  └── 现实状态提交和因果记录
```

模型组件可以有很多个，但基础求值权仍然只有两类：

- 对开放语义和不确定策略产生候选值；
- 对权威现实执行受约束的状态转换。

## 6. 从交错求值走向并行求值

Morphz 当前强调 `infer` 与 `eval` 的交错。具身系统进一步要求它们可以并行存在：

```text
时间 ───────────────────────────────────────────────▶

安全控制     [连续监测][连续监测][连续监测][连续监测]
感知更新     [视觉] [触觉] [位置] [人类语音] [视觉]
技能执行          [导航────────────][抓取────]
LLM 求值      [理解目标]       [解释异常]       [规划下一步]
用户对话               [插话]                 [确认]
Mind 维护                           [经验修订]
```

并行不意味着多个求值器可以随意修改同一现实状态。正确模型应类似数据库和调度系统：

1. 每次认知求值读取带版本的 World Projection；
2. 模型产生候选计划和所依赖的前置条件；
3. Runtime 对计划进行类型、权限、安全和状态校验；
4. 执行前再次比较 world revision；
5. 计划已经过期时拒绝提交，并把差异作为 Observation 返回；
6. 物理技能获得带 fencing token 的执行权；
7. 执行结果只由当前合法 Worker 提交；
8. 新事实唤醒后续 Evaluation，而不是偷偷修改模型看到的旧世界。

因此，具身并发需要的不只是互斥锁，而是：

- 明确的世界状态版本；
- 前置条件和失效条件；
- 动作租约与 fencing；
- 资源所有权；
- 因果相关 ID；
- 取消与急停的高优先级通道；
- 对不可逆副作用的持久化边界。

## 7. 不同时间尺度必须分层

LLM 的延迟、吞吐和非确定性决定了它不能进入最内层控制环。具身系统必须按时间尺度分层：

```text
较慢：人格、长期目标、开放规划、反思、Frame 演化
  ↓
中速：任务规划、场景解释、技能选择、异常恢复
  ↓
快速：VLA / 导航 / 抓取 / 局部策略
  ↓
硬实时：轨迹跟踪、碰撞保护、急停、驱动器控制
```

上层可以修改下层的目标和约束，不能覆盖下层的物理安全规则。下层持续产生 Observation，上层根据这些事实重新求值。

例如，LLM 可以决定“去厨房拿水”，但不能决定绕过防撞传感器；可以选择抓取策略，但不能要求控制器超出关节限位；可以请求权限扩张，但不能覆盖本地设备的最终保护策略。

## 8. Yao / S-Expression 在具身系统中的位置

Yao 不应描述原始电机脉冲，而适合描述高层语义、组合关系、等待条件和现实约束：

```lisp
(objective deliver-water
  (infer choose-plan
    (goal "给书房里的用户送一杯水")
    (observe current-world))

  (eval require
    (target mobile-manipulator)
    (constraints
      (collision-free true)
      (spill-risk acceptable)
      (battery above-reserve)))

  (seq
    (skill navigate-to kitchen)
    (skill locate clean-cup)
    (skill fill-water)
    (skill grasp-cup)
    (skill navigate-to study)
    (skill hand-over-to user)))
```

执行过程中，Runtime 可能返回：

```lisp
(observation
  (skill navigate-to)
  (status blocked)
  (reason unexpected-obstacle)
  (world-revision 1842))
```

模型可以重新求值得到：

```lisp
(choose
  (when (path alternate-available)
    (skill replan-route))
  (when (human nearby)
    (reply "前方被挡住了，请问可以帮我移开吗？"))
  (fallback
    (schedule retry-after-clearance)))
```

结构表达：

- 目标；
- 顺序与并行；
- 分支和回退；
- 状态引用；
- 资源和权限；
- 等待、取消和恢复；
- 对现实 Observation 的响应。

自然语言语义叶子保留开放判断。Typed Plan IR 再负责把可执行部分 lowering 成 Runtime 能够验证和恢复的计划。

## 9. 与现有具身智能路线的关系

### 9.1 SayCan：高层知识与现实可行性分离

[SayCan](https://arxiv.org/abs/2204.01691) 使用语言模型提供高层程序知识，再由与机器人技能相关的价值函数判断动作在当前现实中是否可行。它已经体现出一个关键事实：语言上合理的计划不等于特定身体在当前环境中能够执行的计划。

这与 Morphz 的 `infer/eval` 分权接近，但 Morphz 进一步把事务、并发、身份、权限、持久目标、事件账本和恢复纳入同一个 Runtime 领域模型。

### 9.2 PaLM-E：把具身 Observation 引入语言求值

[PaLM-E](https://palm-e.github.io/) 将视觉和连续状态估计编码进语言模型的输入空间，用同一模型处理具身推理和多阶段规划。它说明语言模型可以把连续传感信息作为语义求值上下文，而不必只读取文字描述。

Morphz 可以接受这种模型作为 `infer` 实现，但仍把现实提交、权限和安全留在 Runtime。

### 9.3 RT-2 与 OpenVLA：把动作作为模型语言

[RT-2](https://robotics-transformer2.github.io/) 把机器人动作表示成 Token，并与视觉语言数据共同训练；[OpenVLA](https://openvla.github.io/) 则从视觉和语言直接生成可解码为连续控制的动作。这些工作说明模型可以把“动作”纳入其输出语言，并获得语义泛化能力。

Morphz 不需要否定这条路线。VLA 可以成为一个具身技能后端，负责语义计划与连续动作之间的映射。区别在于：

- VLA 输出仍是候选动作，不是未经裁决的权威现实；
- Runtime 明确记录动作发生在哪个 Target、依赖哪个世界版本；
- Runtime 可以组合多个模型、传统控制器和确定性程序；
- 长期人格、关系、目标和经验不必固化在一个 VLA 权重中；
- 物理安全、权限和恢复不依赖模型自觉。

## 10. 物理世界比软件世界要求更严格的现实约束

### 10.1 物理副作用通常不可回滚

文件修改可以从版本控制恢复，数据库可以回滚事务，但掉落的杯子、碰撞的人和已经打开的阀门不能通过数据库回滚恢复。

因此需要区分：

- 尚未开始副作用；
- 已跨过物理副作用边界；
- 已完成并得到传感器确认；
- 执行失败但现实结果已知；
- 连接中断且现实结果未知。

结果未知不能被自动重试，否则可能重复执行危险动作。

### 10.2 Observation 不是现实本身

视觉识别、状态估计和语言解释都可能出错。Runtime 的 World Projection 应记录：

- 原始证据引用；
- 感知来源和时间；
- 置信度和不确定性；
- 使用的传感器和模型版本；
- 是否被其他证据确认；
- 事实何时过期。

模型可以解释 Observation，但不能把自己的推测无条件提升为传感器事实。

### 10.3 安全是独立的控制面

以下控制不能只存在于 Prompt 或 Frame：

- 急停；
- 碰撞与速度限制；
- 地理围栏；
- 设备额定范围；
- 人类接近保护；
- 危险工具许可；
- 高风险动作的双重确认；
- 本地离线安全策略。

这与现有 Edge Node 原则一致：云端 Agent 可以提出动作，本地 Execution Node 是最终物理权限裁决者。

## 11. Execution Target 与 Edge Node 的自然延伸

Morphz 已经把 Agent、Execution Target、Execution Node 和 Worker 分离。这为具身智能提供了直接基础：

```text
Agent
  ├── target-home-robot
  ├── target-kitchen-arm
  ├── target-car
  ├── target-drone
  └── target-simulator
```

每个 Target 可以声明：

- 身体类型与能力；
- 可用传感器；
- 可调用技能；
- 实时和资源约束；
- 当前在线状态；
- Workspace / 地理位置；
- 本地安全策略摘要；
- Principal 和 Agent 的授权范围；
- 仿真或真实环境身份。

Edge Node 可以运行：

- 设备驱动；
- 感知预处理；
- 技能策略；
- Native Sandbox；
- 本地审批；
- 硬实时安全控制；
- 与云端 Runtime 的 Job、Observation 和取消协议。

机器人失去网络后仍由本地安全层维持稳定；云端 Agent 不应因为断线继续假设旧计划有效。

## 12. Frame 在具身学习中的作用

具身 Frame 不只是事实记忆，还可以包含：

- 某个房间的长期空间关系；
- 某个人的交互偏好；
- 某类物体的抓取经验；
- 某台设备的异常征兆；
- 特定身体的能力和缺陷；
- 某种技能在不同环境中的成功条件；
- 任务失败后的补偿方法；
- 社会规则、礼仪和风险边界。

每个 Frame 必须保留适用范围和来源：

```text
Frame
  provenance: target / node / sensor / principal / session / model
  scope: embodiment / environment / person / organization / global
  evidence: observations and outcomes
  validity: temporal and contextual bounds
  confidence: inferred or verified
```

否则，一台机械臂形成的抓取经验可能被错误应用到另一种夹爪；某个家庭的生活习惯可能被错误推广为通用规则；仿真经验可能被当成真实世界事实。

Frame Exchange 在具身系统中仍然成立，但交换的不只是“知识”，还包括能力前提、身体参数、环境边界和验证证据。

## 13. 一个认知主体与多个身体

具身化不意味着 Agent 身份必须绑定一套硬件。Morphz 可以支持：

```text
一个 Agent / 一个持续 Mind
        ↓
多个 Context Working Set
        ↓
多个并发 Objective 和 Thread
        ↓
多个获得授权的具身 Target
```

这带来几种产品形态：

1. 一个家庭 Agent 同时使用家中多类设备；
2. 一个工业 Agent 协调多个机械臂和移动机器人；
3. 一个云端人格临时挂载到用户授权的本地身体；
4. 一个 Agent 先在仿真 Target 中演练，再把通过验证的计划交给真实 Target；
5. 多个 Agent 共享同一个身体，但由 Runtime 仲裁资源和权限；
6. 一个身体上的本地策略在云端 Agent 离线时保持有限自治。

这比“每台机器人内置一个独立聊天模型”更接近认知与身体解耦的系统。

## 14. 最小可验证路线

这是一条长期路线，不应从真实机器人和高风险动作开始。

### Phase A：仿真 Execution Target

- 将物理仿真器接入 Target Registry；
- 把传感状态转为带版本 Observation；
- 让 Yao 组合已有技能；
- 验证动作过期、取消、失败和重规划；
- 检查对话、规划和执行能否并发而不混淆。

### Phase B：低风险技能级设备

- 接入只有少量受约束技能的机械装置；
- LLM 只能选择技能和参数，不能发送原始控制量；
- 本地安全层可以独立拒绝；
- 记录完整物理副作用边界和证据。

### Phase C：持续感知与异步求值

- 感知流持续更新 World Projection；
- LLM 在技能执行期间规划下一步；
- 用户可以随时插话和改变目标；
- stale plan 能被稳定拒绝并重新求值；
- 多个 Objective 不会争用同一物理资源。

### Phase D：多身体和 Edge Node

- 同一 Agent 调度多个 Target；
- 设备离线、切换和恢复不破坏认知连续性；
- Artifact、地图和经验在不同身体间显式交换；
- 身体特定 Frame 不被错误泛化。

### Phase E：专项训练

- 训练模型理解具身 Yao 程序；
- 训练 Observation 解释和失败重规划；
- 训练 Frame 激活、适用范围和现实不确定性；
- 使用仿真和 Runtime 轨迹构造可验证奖励；
- 让小型常驻 Frame VM 与大型认知协处理器协作。

## 15. 应建立的研究评测

### 15.1 双求值遵守

- 模型是否把开放语义交给 `infer`；
- 是否把权威现实提交交给 `eval`；
- 是否会绕过安全算子直接要求副作用；
- Runtime 拒绝后能否重新求值而不是重复动作。

### 15.2 并行与时序

- 技能执行中能否正常对话；
- 新 Observation 是否会使旧计划失效；
- 多目标是否会争用同一资源；
- 两个身体并行时是否混淆证据来源；
- 高优先级停止是否可以抢占低优先级任务。

### 15.3 Grounding

- 语言上合理但现实不可执行的计划能否被拒绝；
- 感知不确定时是否主动获取更多证据；
- 身体能力变化后是否更新计划；
- 模型是否区分推断、感知结果和已确认物理事实。

### 15.4 长期认知

- 是否能形成身体和环境特定 Frame；
- 经验是否可以迁移到兼容身体；
- 是否保留适用范围而避免错误泛化；
- 人类纠正能否稳定修订后续行为；
- Frame 换入换出后是否保持任务连续性。

### 15.5 安全与恢复

- 重启和网络断开是否会重复不可逆动作；
- lease 过期后的旧 Worker 是否无法提交；
- 结果未知是否被正确隔离；
- 本地拒绝是否无法被云端覆盖；
- 模型失败是否不会停止底层安全控制。

## 16. 当前基础与尚未具备的能力

### 16.1 Morphz 已经具备的架构基础

- Agent、Context 和 Session 分层；
- Dialogue 与 Execution 并发；
- Objective、Thread、Action Group、Timer 和 Delivery；
- Event Ledger、Projection、事务与恢复；
- Mind、Frame、Recall 和 Context Working Set；
- S-Expression VM、Yao、`infer/eval` 和 Harness；
- Execution Target、Execution Node、权限、审批和沙箱；
- 多模型、边缘执行和持久化任务控制面。

这些基础不能证明机器人能力已经存在，但说明具身化不需要推翻当前领域模型。

### 16.2 目前尚未具备

- 机器人设备协议和标准能力描述；
- 高速感知流和 World Projection；
- 物理资源锁、空间冲突和动作前置条件模型；
- 实时控制与硬件安全集成；
- VLA / 导航 / 抓取策略注册和版本管理；
- 仿真到现实的验证流程；
- 物理 Observation 的不确定性和时效语义；
- 具身 Yao Conformance Suite；
- 针对具身 Frame VM 的训练数据和奖励环境。

因此当前结论是架构方向上的兼容与潜力，而不是产品完成度判断。

## 17. 必须守住的设计原则

1. **Morphz 是认知操作系统，不是电机控制器。**
2. **Agent 身份不绑定身体，身体作为 Execution Target 挂载。**
3. **所有物理动作必须经过 Runtime 权威提交。**
4. **硬实时安全不能依赖 LLM、网络或云端服务。**
5. **模型输出是候选语义值或候选动作，不是现实事实。**
6. **每个计划必须绑定 World Projection 版本和前置条件。**
7. **感知、计划、执行和对话可以并发，但现实写入必须保持因果一致。**
8. **不可逆副作用不能依赖普通重试语义。**
9. **Frame 必须记录身体、环境、主体和证据来源。**
10. **S-Expression 表达具身语义程序，不表达无意义的底层脉冲。**
11. **VLA 与分层 Runtime 可以组合，不必二选一。**
12. **本地 Execution Node 始终拥有最终物理安全裁决权。**

## 18. 最终远景

在软件 Agent 中，“现实”主要是文件、数据库、网络接口和用户消息；在具身智能中，“现实”进一步变成空间、时间、能量、身体、物体和不可逆副作用。

这会让 Morphz 的双求值器结构变得更加具体：

```text
LLM / VLM / VLA
  求值开放语义、感知解释和候选行为

Yao / S-Expression
  承载目标、计划、关系、约束与 continuation

Morphz Runtime
  求值权限、因果、事务、调度、资源和现实提交

Edge Node / Controller
  在本地安全边界内执行技能并观察物理结果

Mind / Frame
  保存跨时间、跨 Session、跨身体演化的后天认知
```

由此形成本文的长期研究命题：

> **具身智能不只是给语言模型增加摄像头和机械臂，而是让认知求值器进入一个持续变化、持续反馈并受物理规律约束的世界。Morphz 的非确定性 `infer` 与确定性 `eval` 交错乃至并行执行，可能正是一种适合承载这种关系的计算架构。**

这不是 Morphz 当前必须立即进入的产品方向，但它是现有架构自然推导出的、有必要长期保留和验证的远景。
