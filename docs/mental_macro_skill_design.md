# Morphz 基于 S-Expression 模板展开的“心智宏 (Mental Macro)”技能机制设计

> [!WARNING]
> 本文依赖固定 `todo_stack/variables` 和旧 `eval` 原语，现作为历史探索保留。任何新的 Mental Macro 必须先建立在 [Agent-Owned Context v1](./morphz_agent_owned_context_design.md) 的 Frame 与 `context_tx` 语义之上。

为了克服传统智能体框架在技能（Skill）使用上面临的高延迟、高 Token 开销和状态容易漂移的硬伤，本方案为 `Morphz` 设计了一套独创的、基于原生 S-Expression 演算底座的**“心智宏 (Mental Macro)”技能机制**。

---

## 1. 痛点分析：传统 Skill 的“肉身”调度缺陷

在 `Hermes` 或 `OpenClaw` 等现有框架的设计中，技能主要表现为一段 Markdown 文档（`SKILL.md`）。当大模型（LLM）遇到困难时，其典型的交互闭环如下：

```
大模型发现报错 ➔ 调用 skill_view 读入 SKILL.md ➔ 大模型理解步骤 ➔ LLM 自己写 To-Do ➔ LLM 调用 exec/write 执行 ➔ 报错 ➔ LLM 重新在上下文中纠错
```

这种模式有三个无法逃避的底层痛点：
1.  **高昂的会话轮数与 Token 开销**：具体步骤的分支判断与工具调用全交由 LLM 在云端进行。原本在本地 1 秒即可顺序跑完的动作，需要 LLM 与控制面来回交互 $5 \sim 10$ 轮。
2.  **注意力漂移（Attention Drift）**：在交互路径长、上下文信息复杂的场景中，大模型极其容易在多轮 Tool Call 的中间步骤发生疲劳或偏置，从而遗漏关键的修复步骤或陷入幻觉死循环。
3.  **心智状态不一致**：大模型需要依靠自然语言将读到的 Skill 与自己当前的 `todo_stack` 和 `variables` 状态进行同步，极易由于理解偏差导致状态失准。

---

## 2. 核心构想：何为“心智宏 (Mental Macro)”？

在 Morphz 体系中，每一个 Skill 在物理上依然是一个人类可读、LLM 可感知的 Markdown 文件，但其元数据（Frontmatter）中包含一段**由状态机原子指令组成的心智宏（Mental Macro）**。

### 2.1 技能声明文件规范 (`skills/<skill_name>/SKILL.md`)
```yaml
---
name: fix-sqlite-lock
description: 当遇到 SQLite database locked 锁死报错时，采用此技能自动修复配置并运行单元测试验证
parameters:
  path:
    type: string
    description: 待修复的 Go 项目路径
# 心智宏：使用我们现有的 Lisp 状态指令，用于直接修改大模型自己的心智变量和 To-Do 规划！
macro: |
  (begin
    (push (todo_stack) (task "调用 write 修改 $path/config.go，将 MaxOpenConns 设为 1"))
    (push (todo_stack) (task "调用 exec 运行 go test ./db/... 确认测试通过"))
    (set (variables db_repair_path) "$path")
  )
---

# SQLite 锁死修复指南 (Markdown Body)
这是 SQLite 锁死修复的原理和备用规约说明，仅在人工调试或深度分析时查看。
```

### 2.2 核心运作流程：一键对齐心智，轨道化执行

```
[ 1. LLM 决策 ] ────► 发现 SQLite 锁死，主动调用: load_skill("fix-sqlite-lock", {"path": "/app"})
                             │
                             ▼
[ 2. 本地宏展开 ] ───► 控制面（Orchestrator）拦截该 Tool，读取 Skill 配置文件
                             │
                             ▼
[ 3. 模板变量替换 ] ──► 将入参 "/app" 渲染替换至 SExpr 宏指令中的 "$path" 占位符
                             │
                             ▼
[ 4. 状态机修改 ] ───► evaluator.rs 原生运行该 macro 动作：
                       • 自动将 2 个子任务 push 进大模型的 todo_stack
                       • 自动在 variables 中记录修补路径
                             │
                             ▼
[ 5. 心智轨道就绪 ] ──► 序列化更新后的 context_state，返回给 LLM（本轮 LLM-API 请求结束）
                             │
                             ▼
[ 6. LLM 轨道执行 ] ──► LLM 在下一轮拿到最新的脑区，直接根据 todo_stack 顶部的指示：
                       • 先跑 write 写入文件，再跑 exec 单元测试，执行完 pop 掉。
```

---

## 3. 核心 API 与工具定义

为了支撑这套机制，控制面在 `Registry` 中注册以下两个 Skill 通用管理工具：

### 3.1 `list_skills` (发现技能)
*   **输入参数**：无。
*   **执行逻辑**：扫描 `skills/` 目录下的所有 `SKILL.md`，提取 frontmatter 中的 `name`、`description` 和 `parameters` Schema。
*   **返回格式**：
    ```json
    {
      "skills": [
        {
          "name": "fix-sqlite-lock",
          "description": "诊断并修复 SQLite 锁死问题",
          "parameters": { "path": "string" }
        }
      ]
    }
    ```

### 3.2 `load_skill` (装载心智宏)
*   **输入参数**：`name` (技能名称)，`arguments` (JSON 格式的实例化参数)。
*   **执行逻辑**：
    1. 根据 `name` 定位到 `skills/<name>/SKILL.md`。
    2. 解析 Frontmatter 中的 `macro` 字符串。
    3. 解析 `arguments`，将宏中的占位符（如 `$path`）进行安全的值替换。
    4. 将替换后的宏文本通过 `crate::sexpr::parse` 解析为 `SExpr`。
    5. 调用 `crate::orchestrator::evaluator::eval_instruction(&mut context_state, &macro_sexpr)` 执行状态演变。
*   **返回格式**：
    ```json
    {
      "success": true,
      "message": "技能 fix-sqlite-lock 成功装载。你的 todo_stack 已被更新，请按照 To-Do 顺序执行后续原子工具。"
    }
    ```

---

## 4. 方案优势与降维打击

1.  **极度节省 Token 与网络延迟**：
    Hermes 模式下大模型需要反复在云端进行多步 Tool Call 交互（来回 5 轮以上网络请求），而本方案通过本地 SExpr 宏解析，在内存中瞬间完成了心智状态注入，**将会话多轮交互降维到了 1 轮**。
2.  **绝对的任务收敛性与防失焦**：
    大模型一旦加载了技能，其 `todo_stack` 中就会硬编码写入标准的排障动作。大模型被放入了“固定的心智轨道”中，只需要专注于依次调用 `write` 或 `exec` 并 `pop`，完全避免了因上下文拉长或异常报错导致的任务失焦与逃逸。
3.  **零安全风险与零依赖**：
    整个心智宏的执行纯粹在 Rust 控制面自己实现的 `eval_instruction` 沙箱内运行，不进行任何直接的外部 Shell 命令调用，从源头上杜绝了注入漏洞；且完全不需要集成 WASM 编译器，保持底座代码的绝对轻量。
