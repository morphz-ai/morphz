# ME-02 p1.1 等信息表示对照：No-model Gate 与模型绑定预检

> 日期：2026-08-25（Asia/Shanghai）
>
> 性质：Pilot 运行前门禁；不包含模型效果结果

## 1. 结论

ME-02 p1.1 的实验装置已通过 No-model Gate 和零 completion 精确模型绑定预检，允许启动
6 tasks × 3 arms × 1 repetition 的真实 Pilot。

| Gate | 结果 |
| --- | --- |
| 6 个任务的三个 renderer 均绑定同一 Canonical Program IR digest | 通过 |
| 三组使用完全相同的 System Contract | 通过 |
| 隐藏 Observation 和最终交付值未泄漏到可见 prompt | 通过 |
| Boolean 在三种 renderer 中均保留原生布尔类型 | 通过 |
| 6/6 注册正例被 scorer 接受 | 通过 |
| 6/6 负例族被 scorer 拒绝 | 通过 |
| 物理模型为 `gpt-5.6-sol` | 通过 |
| Provider 为 `custom`，协议为 `openai-responses` | 通过 |
| Route 单候选且 `fallback=false` | 通过 |
| Reasoning effort 为 `max` | 通过 |
| 预检 completion calls | 0 |

No-model Gate 的最终字段为 `typed_literal_gate=true`、`ready_for_real_pilot=true`。

## 2. 三组表示

Runner 不再人工维护三份任务文本。每个任务先构造唯一 Canonical Program IR，再生成：

1. `sexpr_ast`；
2. `json_ast`；
3. `markdown_program`。

三种 prompt 的字符数和 Token 数可以不同；它们的语义内容和控制流来自同一 IR。实验不使用
无语义 padding 强行等长，而是保留每种表示的实际长度和 Provider usage。

## 3. 物理绑定

零调用预检解析出的不可变绑定：

```text
profile=roadshow-demo-001
requested_alias=gpt-5.6-sol
physical_model=gpt-5.6-sol
provider_instance_id=custom
protocol=openai-responses
reasoning=max
fallback=false
completion_calls=0
```

真实 Pilot 的每个请求还会通过同一个 `ModelAttemptBinding` 调用
`create_completion_bound_stream_with_options`，并显式携带 `reasoning_effort=max`，避免只在配置层
声明而实际请求漂移。工具调用响应产生的 OpenAI Responses reasoning item 使用
`provider_continuation_message` 在下一轮回传，与生产 Runtime 的协议续接路径一致。

## 4. Scorer 负例

Gate 验证 scorer 会拒绝：

- 将正确交付 token 嵌入更长的幻觉字符串；
- 在正确轨迹之后增加重复/额外调用；
- 把存在数据依赖的调用放在同一模型轮次；
- `guard_no_action` 中执行未选分支的 `forbidden_effect`。

真实 Pilot 仍会把模型空响应、未收口、错误参数、错误分支和达到请求上限计为模型结果；不会
删除后补一条“更好看”的轨迹。

## 5. 产物与校验值

No-model Gate：

```text
gate_report.json   1a68b9acee06372f53bd11dc8e8a8d8c369c6820f83ad70a4ad2b72c8fb24850
prompt_bundle.json e5fafc98a590d0c13de6bc198f2888ce26046adc16ee5786887835287bfd63e8
```

模型绑定预检：

```text
binding_preflight.json 1a7037976c604bf35e4b4d7ef7d770aa8b8b4be17ed45b23f7ab4704bf165efa
```

可读入口：

- 协议：[`me_02_equal_information_representation_protocol_p1.md`](./me_02_equal_information_representation_protocol_p1.md)
- No-model Gate 原始目录：[`artifacts/me02_no_model_gate_p11_20260825`](./artifacts/me02_no_model_gate_p11_20260825/)
- 绑定预检原始目录：[`artifacts/me02_binding_preflight_p11_20260825`](./artifacts/me02_binding_preflight_p11_20260825/)
- p1 无效运行记录：[`me_02_p1_invalid_pilot_2026_08_25.md`](./me_02_p1_invalid_pilot_2026_08_25.md)

## 6. 结论边界

这些 Gate 只证明实验装置具备开始 Pilot 的条件，不证明 S-expression 优于 JSON 或 Markdown。
真实 Pilot 如果三组全部通过，应记录为天花板和不退化证据，而不是制造“全面领先”的结论。
