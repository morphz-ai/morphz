---
title: 智能体执行轨迹
description: 从权威事件导出可移植的因果状态转换，并在不执行不可信内容的前提下校验它。
section: concepts
order: 150
status: current
---

智能体执行轨迹是对权威事件和状态的有界投影。它把输入、判断、行动、准入、状态变化和结果组织成可移植的因果图，用于检查、评测或经过授权的训练片段派生。

运行时事件历史始终是权威来源；执行轨迹只投影其中与指定范围有关的因果状态转换。导出、校验和训练片段派生都以只读方式进行。

## 导出的内容

一个执行轨迹包包含：

- 稳定的轨迹身份、规范版本和能力档案；
- 导出来源与认知上下文、目标或激活范围；
- 状态引用、轨迹节点和有类型的因果边；
- 结果、验证记录与奖励解释记录；
- 完整性摘要、变换记录、披露说明和权利声明。

导出器按索引查询选取有界事件，并以外部引用保留范围之外的父节点。导出范围始终由用户选择的认知上下文、目标或激活决定。

## 三种档案

- `AT-Core` 表达基本因果状态转换；
- `AT-Evaluation` 增加评测所需的环境和模型绑定投影；
- `AT-Training` 用于训练片段派生，并且仍需显式训练权利。

默认导出不包含用户消息正文，也不授予训练用途。只有明确使用 `--include-user-content` 才会包含用户内容；`--allow-training` 只能与 `AT-Training` 一起使用。

## 导出与校验

```bash
morphz trajectory export \
  --context-id=context-default \
  --objective-id=<objective-id> \
  --trajectory-profile=AT-Core \
  --output=trajectory.json

morphz trajectory verify trajectory.json
```

校验把输入视为不可信数据，不执行其中的载荷、不访问外部引用、不恢复任何能力，也不写入运行时。它会检查身份唯一性、交叉引用、状态引用、因果无环、范围一致性和完整性摘要。

当前完整性机制使用确定性 SHA-256 摘要检测内容篡改。发布者身份与包中结果的现实真实性需要独立证据。

## 派生训练片段

训练片段同时要求 `AT-Training` 档案和明确的训练许可：

```bash
morphz trajectory export \
  --context-id=context-default \
  --trajectory-profile=AT-Training \
  --allow-training \
  --output=training-trajectory.json

morphz trajectory episode training-trajectory.json \
  --output=episode.json
```

派生结果区分模型输入、监督目标、环境输出和损失遮罩角色。缺少训练档案、权利声明或有效完整性时，运行时会拒绝派生。

## 当前边界

- 导出可以记录范围外父节点，但不会自动带回完整因果闭包；
- 状态主要以精确版本引用和可选差异表达，不自动披露完整认知快照；
- 环境与模型绑定只能投影运行时已有事实，缺失信息不能被推测；
- 数据集分片、同意撤销、训练器适配、规范签名和独立互操作套件仍不属于当前实现。
