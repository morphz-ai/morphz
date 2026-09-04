---
title: 认知应用、领域程序与 Yao
description: 用带版本的领域程序替换默认求值循环，同时保留运行时的调度、权限与事务边界。
section: concepts
order: 140
status: current
---

认知应用把可复用的领域工作方法交给一个已经存在的智能体。智能体身份、调度、权限与认知事务继续由 Morphz 运行时统一管理。

## 三个不同层次

- **认知应用**是面向用户和生态的程序单元，可以组织领域方法、工具、资源与集成；
- **领域程序**（`Harness`）是它的执行语义核心，规定一次求值怎样推理、收集证据、调用工具并形成结果；
- **HNS 包**是当前可安装的最小分发形态，以 `.hns` 文件或目录承载一个主领域程序。

当前实现支持原子 HNS 认知应用。包含多个主领域程序、界面、市场资产与复杂依赖的复合应用包仍不属于当前运行时能力。

## 包含什么

一个 `.hns` 包经过加载后会被归一化为同一套逻辑内容：

- `manifest`：标识、版本、标题、入口和能力声明；
- `contract`：模型可见的稳定领域对象与实践约束；
- 可选 `mind`：只读的默认认知材料，需要显式事务才能进入智能体的持久认知；
- 可选 `fn`：包内函数，只有显式导出的接口对模型可见；
- 一个 `eval` 或 `infer`：本次求值的唯一入口程序。

文件包和目录包采用不同的物理布局。运行时根据归一化内容计算制品哈希，因此同一份逻辑包拥有同一内容身份。

## 安装不等于运行或授权

```bash
morphz harness install ./coding.hns
morphz harness list --format=json
morphz harness show coding@1.0.0 --format=json
```

安装会校验包结构并把精确版本加入本地目录。相同标识和版本若对应不同内容会被拒绝；运行时也不解析 `latest` 之类的浮动版本。

安装后的领域程序保持未激活状态，也没有工具权限。目标可以声明默认绑定：

```bash
morphz objective create \
  --harness=coding@1.0.0 \
  repair the workspace and verify the result
```

目标启动求值时，运行时会把精确领域程序标识、版本和制品哈希固化到本次求值绑定。后继激活继续读取同一绑定，不会在运行中静默切换包版本。

## `eval` 与 `infer`

Yao 是当前 HNS 形态使用的类型化 S 表达式程序语言。入口决定谁控制求值循环：

- `eval` 由运行时拥有控制权。运行时把入口降低为持久类型化计划，并可把有界推理步骤交给模型；
- `infer` 由模型拥有求值循环。模型在当前领域契约中推理，并通过显式函数调用请求下一步行动。

两种入口都由运行时执行验证。工具执行、认知事务、调度、等待、恢复和物理副作用仍由运行时持久化并实施。

## 函数与能力

包可以声明类型和函数。模型可见上下文包含导出函数的名称、类型、说明和副作用接口；私有函数及函数体留在包内。执行时，函数按精确求值绑定静态链接，作用域限于当前绑定。

领域程序声明的能力只是需求，不是授权。实际工具调用仍要通过：

1. 当前主体和因果线程；
2. 目标与执行节点授权；
3. 沙箱和宿主策略；
4. 一次性审批或仍然有效的能力租约。

领域校验可以进一步收窄行为，但不能扩大这些运行时边界。

## 一个最小包

```lisp
(manifest
  (id research)
  (version "1.0.0")
  (title "Evidence-led research"))

(contract
  (identity "research")
  (outcome "a conclusion with explicit evidence boundaries"))

(infer
  (requires (tools))
  "Collect evidence, preserve disagreements, and state the conclusion.")
```

`.hns` 是包后缀；认知应用是用户面对的程序，领域程序定义执行语义，Yao 是当前包使用的源语言。

完整命令参数见[命令行参考](/docs/cli-reference)。
