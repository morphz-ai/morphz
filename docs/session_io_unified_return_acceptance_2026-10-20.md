# Session IO 统一返回验收（2026-10-20）

状态：**原窗口真实长 Context 验收未通过，不能交付。** `1fa0771821f5`
已部署，隔离与新 Context 的接口验证通过，但 04:43 与 04:49 的原窗口
读取测试先后暴露了“工作提案被当正文完成”和非法 JSON 中断。锁屏已不
再是阻碍；缺口是实际可靠性。以下历史通过项仅代表其原有测试范围。

## 修复边界

- 新 Evaluation 冻结 `morphz.evaluation@2`。模型交付一个包含业务正文、
  实际工作提案和显示注解的值；Runtime 构造外部 Message、调用身份和终态。
- 已验证的 DeepSeek 原生 Responses 入口实际收到 `text.format.json_schema`。
  采用 `strict:false`，保留原业务参数定义，不宣称服务端提供强制解码保证。
  `tool_choice:none` 只是稳定选择同一个返回载体，不改变工具目录或权限。
- 开启时强要求适用的实际工作注解；接收端允许缺失及无效显示字段，关闭时
  不投影注解。普通无工具聊天没有活动标题／结果要求。业务类型与权限仍严格。
- 无独立注解伴随调用、正文标记、补注解推理或答案中继。正文示例是数据。
- 旧任务恢复保留原冻结格式，旧提交不重放；新规则不重新解释旧值。
- typed infer 的实际类型定义发送到上游；流式保留原值与大整数，公开显示
  仍须有父流程投影证明。修复隐式 typed 返回漏掉公开回复快照的问题。
- Context、Yao、恢复与冷却提示统一以冻结返回定义为准，消除旧 `calls[index]`
  指令与禁止整个 Evaluation 外层的矛盾。历史 native 绑定仍沿用 native 调用。

## 自动化证据

| 范围 | 结果 |
| --- | --- |
| `cargo test -p morphz --lib -- --test-threads=1` | 1,626 通过、0 失败、13 原有忽略；343.99 秒 |
| 注解 Runtime 集成 | 26 通过，含重启保持旧格式及 v2 开关两态 |
| Session IO Evaluation Runtime 集成 | 8 通过 |
| Session IO PostgreSQL 并发交付、显式围栏 | 2 项分别在新建独立数据库通过 |
| 应用 Session IO、注解显示／平台／Runtime、Provider 路由 | 39 通过、0 跳过；包含 SQLite 与 PostgreSQL |

完整库前两轮并发执行出现时序失败：第一次还发现真实的 typed 公开投影
缺陷及三个陈旧提示断言，均已修正；另有超时和物理传输重复请求测试在
独立复跑通过，最终串行完整库通过。没有放宽业务断言或增大这些测试超时。
13 项忽略包含外部登录、其他 PostgreSQL 与终端快照测试；不计为通过。
上表的两个 Session IO PostgreSQL 测试已单独补跑，其余未执行。

应用集成夹具已改为按实际冻结 v2 绑定生成一个响应值，而不是继续生成
已禁止的注解伴随调用。故障用例仍验证真实失败状态及错误原因，不造答案；
迟订阅验证原有前缀恢复、完成前实时增量、单次最终提交及没有额外模型请求。

## 真实 DeepSeek（合成数据、独立 Runtime）

物理入口为 `https://api.deepseek.com/responses`，模型 `deepseek-flash`，
推理强度 `max`，重试为 0。不是回放模型，也未使用原用户数据库。

| 场景 | 模型请求 | 已核验 |
| --- | --- | --- |
| 普通无工具聊天 | 1 | 完整流式正文，无活动注解要求 |
| 读取合成故事后判断，注解 on | 2 | title、intent、结果注解及正文，实际读取一次 |
| 同一工具场景，注解 off | 2 | 注解不投影，工具目录与 on 相同 |
| 读取合成进度 | 2 | 实际结果、观察说明、正文及流式 |
| 保存合成 Mind 进度 | 2 | 真实一次提交、读取提交事实后回答 |
| String typed infer | 1 | 引号、换行、中文及 emoji；公开正文增量，无中继 |
| Decision record typed infer | 1 | `false`、`9007199254740993`、中文完整；内部值不泄漏 |
| 原 script-studio 的 discuss-script 流程 | 2 | 两个真实只读 Host 操作，类型返回与正文流，无额外推理 |

保存进度的一次复测触及探针的 4,096 输出 token 上限，保留为失败记录；
改用 8,192 的隔离测试预算后通过，不将前次失败算为通过，也未为此修改
原应用预算或加入自动修复请求。

实际 typed 请求经过只转发原始字节的隔离记录器核验：上游 HTTP 200，
`json_schema`、`strict:false`、`tool_choice:none` 以及 Decision 布尔／整数
定义确实在请求中；一条请求完成记录类型校验。记录器不保存认证头。

运行入口为 `morphz/examples/session_io_runtime_probe.rs`；既有研究及原始
合成返回见 `session_io_*research_2026-10-20.json`。这不是 Qwen、Kimi、GLM
或任意量化模型的兼容性结论；其矩阵按用户决定后补。

## 原应用更新记录

2026-10-20 04:29（Asia/Shanghai），原安装应用继续连接原端口与原数据，
独立 Runtime 已从 `9051ee730c42` 更新为 `1fa0771821f5`，PID 71638。
Electron 原进程 PID 44726 保持运行；本次没有生产 UI 代码变更，不通过
重启桌面或新建手工测试 Profile 冒充原应用更新。

切换前没有执行中的 Activation/Job；原配置和两份 SQLite 在线备份均
通过 `quick_check`。只把 `deepseek-flash` 路由改到原生 Responses 入口，
沿用同一已有 DeepSeek 凭据并存入 macOS Keychain。两个 GPT 路由、原代理
实例、原账号和默认模型保持一致，没有把凭据降级成明文文件。

在原 Runtime 新建明确命名的 TEST Session，使用合成文件，分别验证：

| 原部署场景 | 模型请求 | 实际结果 |
| --- | --- | --- |
| DeepSeek 普通聊天 | 1 | 完整正文、零活动注解，无工具调用 |
| DeepSeek 读取文件，on | 2 | 实际读取一次；标题、步骤意图、观察说明、结果齐全；正文 44 个实时增量 |
| DeepSeek 重新读取同文件，off | 2 | 实际读取一次、零注解；正文 48 个实时增量 |
| GPT 原路由聊天 | 1 | 保持原代理；正文 7 个实时增量，无工具调用 |

后三项均通过正式 Session IO 输入和订阅入口，正文在最终提交前到达，
每项只提交一个正文；开启注解时另有 Runtime 构造的类型化注解事件，
不是模型的第二条伴随调用。没有补注解推理、格式修复或答案中继请求。
原始合成响应、SSE 记录及逐项核验摘要保存在私有切换备份中，摘要和
SHA-256 见 `session_io_original_runtime_acceptance_2026-10-20.json`。

首次 on 采集器按 root_turn_id 查找终态，漏掉仅带 Thread ID 的终态，
且把类型化注解提交也计作正文提交。已据原始捕获流和持久化 Thread
逐项复核，不重跑模型、不丢弃证据；它不是一次产品执行失败。

数据对照：39,319 条旧 Event、782 个 Thread、4,217 个 Activation、
4,374 个 Job、49 个 Plan、4,325 条 Timer 及 5 个 Objective 未改写或删除；
原工作区、附件、书籍、章节、阅读数据与对象输出保留。正常启动追加了
两条“等待目标已恢复”的审计事件，没有重放工作；只推进对应会话的
活动时间及客户端游标。两项未来定时计划的身份、到期时间与状态不变。

## 原窗口长 Context 反例（04:43—04:52）

正常刷新原应用，在原 TEST 项目新建 `TEST Session IO 统一返回验收 1020`
会话，使用原共享 Context（snapshot 389），选择实际 deepseek-flash / max。
请求只读已有合成测试书 section-3，禁止改记忆、书籍、文件和使用网络。
没有新建替代 Profile、清空 Context、降低思考强度或关闭注解。

1. Thread `thread_4c650628b50ac8ffbb3261f8`：一轮请求返回 Markdown 代码块
   中的 `{body:null,effects:[list_skills],annotations:...}`。v2 解码把代码块
   当作隐式正文并标 completed；112 个公开增量展示了提案，没有实际读取。
   这是验收失败，不能以 terminal=completed 或有输出计作成功。
2. Thread `thread_69bc300b5195ad4923a9b046`：明确要求实际读取的诊断续测，
   共五轮模型请求。先后列技能、提交错误 Host 参数（被拒）、列操作、describe，
   最后读取提案在 `intent` 前多闭合一个 `}`，报 `Invalid JSON at byte 281`。
   未执行该读取。已显示真实标题／步骤注解，但任务仍失败，不计为通过。

本次冻结输出确为 `morphz.evaluation@2`；物理路由为原生 DeepSeek Responses，
不是旧代理或旧 Runtime。已捕获完整当前请求（仅留在私有 0600 文件），
Context 压力估计约 147,866 token，工具目录含 34 个工具和原有 no_reply。
输入侧仍可见旧注解描述中的 native calls 索引语义，须继续审查层级区分。

实际长请求的隔离逐字节转发确认上游收到 `text.format.type=json_schema`、
`strict:false`、`tool_choice:none` 和 35 个相同工具定义；HTTP 200 本身不能
证明可执行。该对照虽是合法 JSON，仍生成缺少 `action` 的 Host 参数。
仅补 JSON 序列化提示或改为 json_object 的对照也分别产生了错误 Host
参数、未知工具名；两者都不是修复验收。strict:true 对当前同一 Schema
返回 HTTP 400：`An object with no properties is not allowed`，不能静默裁剪
原业务 Schema 或把 strict:false 当成强保证。

私有原始证据位于切换备份的 `original-window-stream.json`、
`original-request-1.json` 至 `original-request-5.json` 与 `captured-*.json`。
其中包含真实 Context，禁止提交源码仓库。后续只提交去私有信息的摘要。
当前没有把上述失败修补成成功、剥离代码围栏执行、增加自动模型修复轮，
也没有因实验切换生产返回方式。原 Runtime PID 71638 与定时任务保留。

05:06 再次抓包得到上游非法 JSON 反例，response ID
`9a747390-ff96-48c3-9908-3feae77748aa`。SSE 增量拼接、上游最终正文与
Adapter content 完全一致，排除了该反例的流式拼接问题。原生函数调用
对照则通过原 Host 参数纯校验，但没有执行，不作为原应用通过。
完整研究及需要 review 的后续机制见
[Responses 实际链路调研](session_io_responses_findings_2026-10-20.md)。

**剩余门槛是修复并重新通过真实长 Context 的完整读书链路、正文流和终态，
不是补一张窗口截图。** 目标仍未完成；其他模型矩阵仍未验证。
