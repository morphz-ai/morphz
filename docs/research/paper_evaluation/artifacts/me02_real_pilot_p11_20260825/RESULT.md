# ME-02 p1.1 等信息递归表示真实 Pilot 结果

> 日期：2026-08-25  
> 状态：`pilot-complete`  
> Run：`ME-02-pilot-p1.1-20260825T110315.839Z-85232`  
> 冻结实验 commit：`f42f9069bc38df5104b1ff0ac3587b89ecd9f3df`

## 结论

修正实验装置后，6 个任务 × 3 种等信息表示共 18 个 episode 全部严格通过：

| Arm | 严格通过 | 语义通过 | 平均模型请求 | 平均工具调用 |
| --- | ---: | ---: | ---: | ---: |
| S-expression AST | 6/6 | 6/6 | 5.33 | 4.33 |
| JSON AST | 6/6 | 6/6 | 5.33 | 4.33 |
| Markdown Program | 6/6 | 6/6 | 5.33 | 4.33 |

该 Pilot 支持以下有限结论：在当前任务与模型上，S-expression 能作为程序与数据的统一递归表示被可靠读取和求值；相对于同一 Canonical Program IR 生成的 JSON AST 和 Markdown Program，未观察到最终行动能力退化。

该 Pilot 不支持“S-expression 优于 JSON/Markdown”的结论。三组 18/18 表明当前任务存在天花板效应；具体括号语法不是已观察结果的优势来源。更符合证据的论文表述是：核心机制依赖可递归、可寻址、可求值的结构化表示，S-expression 是一种紧凑实现，而非唯一可能语法。

## 完整性与运行条件

- 物理/逻辑模型：`gpt-5.6-sol`
- Provider：`custom`，OpenAI Responses 协议
- reasoning：`max`
- 单候选，禁止 fallback
- 绑定 endpoint：`http://mini-m4.local:8317/v1`
- 18 个 episode 均使用独立消息与工具状态
- 失败 episode：0
- Provider 错误：0
- 总模型请求：96
- 总工具调用：78
- 15 个包含工具调用的 episode 均记录并回放 Provider continuation；缺失：0

## 描述性 Token 记录

这些数据只用于诊断和后续任务设计，不构成效率结论。Provider cache 命中不同，且样本量只有每组 6 个。

| Arm | Provider input | Uncached input | Cached input | Output | Reasoning | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| S-expression AST | 43,197 | 38,589 | 4,608 | 1,621 | 855 | 44,818 |
| JSON AST | 61,190 | 42,246 | 18,944 | 1,370 | 606 | 62,560 |
| Markdown Program | 48,545 | 37,793 | 10,752 | 1,410 | 644 | 49,955 |

初始程序表示的平均字符数分别为 S-expression 515.5、JSON 2,270.3、Markdown 870.5。它说明三种 renderer 的表面长度不同，但不能单独推出系统总体 Token 或任务效能优劣。

## p1 无效运行与 p1.1 修正

首次 p1 运行永久标记为无效，原因是 Canonical IR 把布尔值 `true` 错建模为字符串，并且 runner 未回放 Responses continuation。p1.1 引入原生 Boolean IR、typed-literal Gate 和 Provider continuation 回放后，从冻结 commit 重新运行全部 18 个 episode。无效运行未删除、未混入本结果。

## 后续

不重复当前容易样本制造虚假统计量。若 ME-02 需要确认性结果，应先冻结更长的组合求值、嵌套作用域、共享引用和干扰项压力任务；继续保持同一 Canonical IR、等信息 renderer 和隐藏 scorer。长期状态、compaction、并发事务等问题分别归入 ME-06 和 ME-04，不混入本表示消融。

## 原始证据

- `report.json` SHA-256：`b7100796705335bf4850cfb4a9458b2fe92286e1284857e0287ee46064175ee1`
- `prompt_bundle.json` SHA-256：`e5fafc98a590d0c13de6bc198f2888ce26046adc16ee5786887835287bfd63e8`
- 原始目录：`ME-02-pilot-p1.1-20260825T110315.839Z-85232/`

