# 人格化个人助手：Profile 与只读 ROM

状态：2026-10-02 Runtime ROM、Host/Profile 与 UI 首轮已实现。用户实际测试发现：未保存的预填数值被误看为有效配置，原生默认头像被否决，首轮缺少 UI 保存到实际模型请求的整链路证据。当前“不设置”及 Logo 修复已通过实际链路、独立真实模型与原窗口验收，详见下方记录；这不等于整个长期人格化目标或主观表达效果已经完成。历史证据保留，并区分隔离测试、原窗口及真实模型结果。

### 2026-10-02 资料优先的展示修正

默认身份区只展示圆角头像和已确认名字，不把 Profile 绘成常驻姓名标签、开关和输入框的配置卡。名字、Human 称呼可点击／键盘进入局部编辑；打开和关闭查看本身零写入，展示回退不转成 ROM。局部「不设置」沿用稀疏 null，文本继续自动保存；完成／Enter／Escape 是结束编辑而非撤销已提交结果，组合输入期间不退出，Escape 不触发原生 dialog cancel。个性与表达折叠摘要仅来自已确认且已启用的字段，无设定显示「由模型决定」，不生成新简介、虚构人格或额外模型请求。「能力与连接」为独立折叠操作组，原入口保留。

总开关仍在标题右侧，关闭整份不使用；头像独立，桌面更换按钮仅悬停／键盘进入时出现。页签 Logo 继承同组图标颜色，身份与左侧品牌不改。右栏显隐、合法页签及宽度在原 center／principal 的界面偏好中保存，与左栏状态独立；不将旧执行图钉或具体 Thread、root、input 存为刷新恢复指令。以上为消费者展示调整，没有修改 Runtime、Host、schema、版本绑定或 prefix-cache 契约。

本轮最终 Profile／Dock **43／43**（41.4 秒）、侧栏刷新／原伸缩 **14／14**（29.5 秒）、实际 UI → typed Host → 隔离 SQL → Rust Runtime → Provider 请求 **5／5**（14.5 秒），相关单测 **39／39**；全部零跳过。日志 `/tmp/morphz-profile-person-final-proof.log`、`/tmp/morphz-subject-reload-final.bWBaCA/final-ui.log`、`/tmp/morphz-profile-person-final.Uh5aje/deterministic-person-final.log` 和 `/tmp/morphz-profile-person-sidebar-unit.log`。实际链使用确定性 Provider 做字节验证，未新增付费模型或人格质量验收；DOM 的 IME／Escape 与 CSS 200% 不冒称原生系统输入法或 Electron 缩放。原同一 App 载入并只读实看双方资料，再次刷新后右栏自动保持设定及宽度，左栏保持原状态；前后 240／240 表逻辑摘要一致，未替用户改 Profile 或发送消息。完整实施及失败记录见 `13-implementation-status.md`。

## 1. 产品边界

Agent 可以有名字、头像、幽默、严谨、亲和、详略和讲话风格；Human 可以设置自己的名字、希望 Agent 怎么称呼自己和头像。名字是显示身份，不重命名 Principal、Agent ID、Context、Session、Thread，也不搬移历史或取消工作。当前中心仍是一位 Agent，不增加成员管理、每项目 Agent 或新聊天体系。

用户提出的 ROM 是更基础的机制：调用方设定的结构化出厂配置，Agent 只读。Profile 是它的一个消费者，不是将人格偷偷写进可被 Agent 改删的 Mind。结构嵌套不是权限证明，Runtime 必须实际隔离写入口。

认知层次：Runtime 认知虚拟机和真实权限 → 受授权调用方的只读 ROM（助手职责、人格等自由结构）→ Agent 自己形成和管理的 Mind。自由 BODY 仍由语义处理器解释；Runtime 不硬编码幽默或行业业务规则。不用普通记忆 Frame 的 protect 冒充只读：现有 protect 只限制 retire，不能防 revise 或 Agent 自己 unprotect。

风格参数使用 **0–5 六个值**，不是温度、智能或工具权限。严谨度调节核查和解释的表达密度，0 也必须诚实、保留不确定性，不能胡编或跳过必要验证。幽默不调侃严肃风险，亲和不无条件附和。自定义风格不能覆盖真实身份、安全规则、审批、授权或工具协议。

## 2. 生产数据权威

| 对象                   | 唯一权威与范围                                                    | 非权威部分                                                            |
| ---------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Agent 名字、人格与风格 | Runtime ROM，实际 Agent ID，全 Agent 范围                         | Host/UI 的类型化解析与显示缓存                                        |
| Human 名字与称呼       | Runtime ROM，实际 Agent + 真实 initiating Principal 私有范围      | Team 认证名仍来自现身份配置，不将个人称呼公开给队友                   |
| Human / Agent 头像指针 | Platform，tenant + subject kind + 稳定 subject ID                 | Client 只持有短期受权资源 URL                                         |
| 头像和首帧字节         | 配置的中心 ManagedArtifactStore，明确接收的原格式与不可变首帧版本 | 不入 Objects 内容目录，不放 Renderer/localStorage，不复制平台业务正文 |
| 执行使用的 ROM         | Runtime Thread 的不可变 manifest/version refs                     | 不是当前 heads 的随时跳转别名                                         |

Profile 不写 members.json、认证凭据或整个工作空间 JSON。两域逻辑隔离，允许物理共置。名字/风格保存与头像保存是两个操作和两个修订，不假称 Runtime 与 Platform 跨库 ACID；每个操作独立读回、冲突和重试。

## 3. Runtime ROM 模型

### 稳定对象与版本

新增独立 `AgentRomStore`，不改变 Mind schema：

- `agent_rom_heads`：entry ID、Agent 外键、ASCII namespace、可选 Principal scope、当前 revision、创建/更新时间。公开 `(agent_id, namespace)` 与私有 `(agent_id, namespace, principal_scope)` 分别唯一。
- `agent_rom_versions`：`(entry_id, revision)` 主键、enabled、canonical S-expression、格式版本、schema tag、内容 hash、真实控制面修改方与时间。版本不可变；停用也创建新修订，不删历史。
- `agent_rom_command_receipts`：command ID、真实 authority、规范请求 hash、entry、expected/committed revision 与提交时间。同 actor / 请求原样重试返回原回执；同 ID 换内容拒绝。
- `thread_rom_mounts`：Thread 主键、Agent、根 initiating Principal、manifest hash、绑定时间。**空 mount 也是确定版本**，不能把未绑定和已绑定空配置混为一谈。
- `thread_rom_bindings`：Thread + entry 主键，精确 revision 和稳定 ordinal，外键引用不可变版本。

按主键/唯一 scope 查询，不扫描整租户配置。SQLite / PostgreSQL 相同 CAS、幂等与外键语义；HEAD、VERSION、RECEIPT 在本域事务中提交，Thread mount 及 bindings 也在本域原子绑定。新增是有界单条配置，不是全空间 JSON 快照。

每条 BODY 上限 8 KiB，单一 S-expression、深度 32、节点 4096；选中的全部 ROM 上限 32 KiB，每个 Agent 最多 32 条。须在递归解析之前防止畸形深嵌套造成栈问题。规范化后计算带 domain 和 format version 的 hash，编码不带每次请求时间、随机值或临时 URL。namespace 排序稳定，停用条目不进入模型上下文。

### 只读与授权

Rust SDK 的受信 operator / Host 入口提供 get/list/put；HTTP 同样走现有 operator 认证。目标 Principal scope 只是配置的作用对象，不能作为请求者认证。Runtime 当前 Agent 没有可据以推导人格管理权的完整 owner/ACL，参加 Session 不能视为全 Agent 配置修改权。

模型不获得 ROM 写工具。现有 context_tx、revise、retire、unprotect、restore、rollback 仅操作 Mind，不接触 ROM Store；Frame 名称碰巧相同也不能修改 ROM。Human UI 必须先经 Host 的真实身份与授权再调用受信接口，第三方调用方需获授权的控制面能力，沙箱 UI 的旧 command 权限不自动扩大。

Profile 首阶段：Human 只能改自己的私有资料；本机单用户中心的真实主 Agent 可由本机 Human 修改；Team Agent 尚无管理员边界时只读。Agent 可读对应 Profile 或提交待 Human 确认的建议，不能自行 put ROM 或换头像。UI 与 Agent 使用同一类型化领域操作和真实权限判定，不靠操作 GUI。

Team Host 将两种凭据分开：原 gateway token 只用于确认真实 Human 的 `/api/principal/self`；受保护 `runtime.json` 的 `operatorToken` 或 `MORPHZ_APP_RUNTIME_OPERATOR_TOKEN` 仅供 Host 查询状态和访问 ROM 控制面，不传给 Renderer、Agent 工具或连接详情。未配置私有 operator 凭据时明确不可用，不尝试以 gateway 权限管理 ROM，也不开放 Team Agent 编辑。本机单用户兼容现有 operator token。凭据拒绝非法 header 字符；网络错误不得回显 Authorization 或底层错误里的密钥。

### 生命周期与旧语义

旧 Thread 迁移确定为空 mount，不能部署时无声改变在途/未来已安排工作的设定。新 Thread 在开始模型 Evaluation 前一次性绑定当前有效 heads，包含全 Agent 配置及**仅根输入 initiating Principal 精确匹配**的私有配置；没有根 Principal 不回退到 Session 目录默认 Human。

同一 Thread 的 tool continuation、多个 Attempt、失败重试和重启恢复始终读绑定旧版本。新工作用新设定，已有工作不切换。保存不创建 Agent、Session、Objective、Harness 或输入，不重放旧消息。版本保留满足旧绑定恢复，不用临时诊断 model snapshot 冒充持久版本库。持久 Attempt metadata 要能追溯实际 manifest、版本及编译契约。

### Context 与 prefix cache

有配置时的固定顺序：`protocol → rom → evaluation-profile → inbox → observation-state → mind → session-directory → kernel → evaluation-environment → evaluate`。ROM 在现有 segmented cache 稳定 prefix 内，早于动态输入和投影。没有 ROM 时完全省略槽，保留旧 Context 与系统提示字节及旧请求语义。

ROM 规范编码只含稳定内容、精确版本/hash 与作用范围，不把当前时间、头像 URL 或 transient UI 状态放入 prefix。变化只发生在调用方真正提交新配置且新 Thread 绑定时；不承诺改变人格还可以命中旧 prefix。

普通 prefix 缓存按实际 bytes；实验 structured-delta continuation 的 contract digest 还必须校验 ROM manifest 与 compiler contract，不能已保存新设定却重用旧 Context seed。空 ROM 保留原契约；改版本、新 Thread、其他 Principal 不跨作用范围复用。系统外显名字与 ROM 的角色设定冲突只在 active ROM 时明确处理，底层 Morphz/kernel 身份和安全指令不弱化。

## 4. Profile 的结构化消费者

### 2026-10-02 修复：显式设置与不设置

唯一权威仍是既有 Runtime ROM，不新增 Profile 数据表或 Renderer 持久配置。v2 保持两种 namespace 与 subject 身份不变；每个业务字段允许 `null`，表示“不设置”，不是数字 0、自然风格或自动取名。新的 Agent / Human 表单默认全为 `null`，整份 Profile 默认停用。备用显示名 Morphz / 认证身份名仅用于 UI，不因此进入模型上下文。

- 全局启用状态使用不可变 ROM version 的既有 `enabled`。关闭整份 Profile 保留显式设置，以便再次启用，但新 Thread 不选择其内容；读取停用记录仍可编辑，不能误报服务不可用。
- 逐项关闭将该值清为 `null`；编译完全省略相应字段，而不是写入默认值或 unset 指令。全空时强制停用，空 BODY 不附加风格 contract 或数值说明。其他调用方 ROM namespace 不受影响。
- 姓名、称呼、四项数值、讲话风格、自定义风格均独立选择。数字 0 是明确的最低偏好，5 是最高；选中值的 ROM 要解释量表及行为含义，并明确这是配置偏好而不是模型权重、温度或能力。询问已配置数值时应如实报告 `值/5`。
- Typed snapshot / 写回回执分别返回 `enabled`、确切 revision 和稀疏 data。保存采用原 CAS / command ID；未知结果重用命令，冲突需明确恢复，头像仍有独立 Platform 修订，不随 Profile 开关消失。
- 新写入 schema tag 使用 `morphz-agent-profile/v2` / `morphz-human-profile/v2`。已保存 v1 读取为原明确数值及原 enabled，不自动迁移、重写或停用；只有用户下一次显式保存才写入 v2。旧 Thread 的已绑定版本及恢复语义不变。
- Agent 无上传头像时统一使用现有 Morphz Logo，撤掉首轮紫色卡通，不改变 Human 的默认人像、已上传资源或上传能力。头像不进入 ROM，也不要求启用人格才能上传。

2026-10-02 控件层级后续修正：Agent 的正向「使用人格设定」开关放在「设定」标题右侧，Human 的「使用个人资料」放在对应标题右侧，不再单独占一个重要行。不使用是正常选择，不使用“暂停”文案或自动恢复；既有 `enabled=false` 即权威，不增加永久禁用标志或新数据模型。首次有效单项会自然启用，有保留值但已关闭时新增字段仍保持关闭；暂时空名字按自动保存队列沿用已确认名判断，不因中间态重新打开。全空时总开关禁用，名字 placeholder 和新空控件不构成 ROM；明确清空最后一项后再设置首项可以自然启用。

验证必须包含真实 UI typed 保存 → Host → Rust Runtime 持久版本 → 新 Thread 实际 Provider 请求。受控 Provider 用于确定性字节断言；如执行真实模型 probe，另记实际结果，不能把模拟回应当作模型已遵循。全关闭的请求需证明无 Profile 内容、系统扩展和旧缓存契约变化；原同一 Electron 窗口需要实看 Logo、未设置状态及升级后原数据保留。

下文 v1 为首轮格式的历史记录，不是新表单默认值。

约定 namespace / schema（业务由 Host 定义，Runtime 仅存自由结构）：

- `morphz.profile.agent` / `morphz-agent-profile/v1`：name（1–40）、traits（humor / rigor / warmth / verbosity，0–5）、speechStyle（natural / concise / thoughtful / direct）、可选 customStyle（≤500）。
- `morphz.profile.human` / `morphz-human-profile/v1`：name（1–40）、preferredAddress（0–40），必须 private Principal scope。

BODY 使用实际结构而非整份 JSON 字符串，例如：

```lisp
(agent-profile
  (identity (name "Morphz"))
  (personality (humor 2) (rigor 3) (warmth 3) (verbosity 2))
  (speech (style natural) (custom ""))
  (contract "表达风格不改变事实、身份、审批和授权底线。"))
```

```lisp
(human-profile (name "用户的名字") (preferred-address "用户希望的称呼"))
```

初始化是显式保存或选择保留 Morphz，不提前凭空创建配置，不自动替用户取名。起名引导只在 Agent Profile 的明确入口呈现，不插入消息、打断或创建空 Session。默认值是 UI 的明确未配置 fallback，不假称 Runtime 已保存。

## 5. 头像领域

Platform 头像指针以 `(tenant_id, subject_kind, subject_id)` 定位，保存自身 revision、原件及首帧的精确 StoredVersion、真实修改人和时间。PK 满足本人和主 Agent 查询；SQL 源、版本/已知 hash 迁移和 SQLite/PostgreSQL 校验同时更新。

首版只接受 PNG、JPEG、GIF、WebP，≤4 MiB、每帧≤2048×2048、动态图≤120 帧/30秒且总展开像素≤32 Mi。禁 SVG、HTML、APNG、视频、远程 URL 和任意路径。服务端核验 magic / 格式、有界 metadata、解码限制和 timeout；独立 Worker 五秒 deadline 到期终止、native pipeline 三秒 timeout。这不是进程级 CPU 沙箱，metadata 不等于全帧像素已解码。受限首帧解码并保存≤256×256 PNG poster；保留用户原动态图，不谎称能按任务生成口型。

字节先经 Managed Store 暂存、hash/大小/格式验证和不可变发布，再在 Platform 事务中 CAS 绑定两个可读版本并写 command receipt。失败不留下悬空头像指针，未引用字节按保留规则管理；删除头像是 CAS 清空指针，不能顺手永久删除历史字节。重试同 command ID 查询原回执；身份撤销后即使重复命令也重新检查权限。

资源请求先检查当前身份和 subject 权限，再读取当前精确版本，以短期受权 token 定位，不靠裸 SHA 或 caller owner 参数；读取前后核对实际 session/身份。多 Host 必须可读取同一配置 Store；无中心字节后端则明确拒绝，不静默退回某台 Host 私有目录。备份/恢复要包含头像关系、Store manifest/bytes 与配置，SQL 备份不能宣称已备份头像。

## 6. 审美与动效准则

研究不是照抄皮肤。[Muse 官方产品导览](https://www.youtube.com/watch?v=wHn0hTjvFoo) 把聊天和内容保留为主体；[Meta 头像研究展示](https://research.meta.ai/blog/bringing-your-muse-to-life) 用柔和材质、少数表情部件和留白表现存在感；研究页明确不等于所有角色已在产品开放。[发布者通话屏录](https://x.com/alexandr_wang/status/2102923941669171330) 标注 coming soon。[Masko 官方 Companion](https://masko.ai/companions/ai-desktop-companion) 与[四秒预制动作](https://assets.masko.ai/7fced6/ko-95a7/listen-focus-aac994c2-360.webm) 展示了外观和 Working / Waiting / Done 状态的分离。它们不证明我们的 Runtime 或生成式视频功能。

本产品采用：身份、工具状态与产品品牌分开；侧栏小头像低幅慢频，不在每条消息/菜单/按钮加动画和常驻说明。首轮原创卡通被用户否决，当前无上传头像时使用既有 Morphz Logo，不给 Logo 贴眼睛或再加未经确认的角色。当前工作状态来自现 Runtime/stream 事实，不用 hover 或永远循环冒充正在执行。

Profile 主视觉只有头像和名字；人格控制采用统一少量 0–5 控件，短标签、清晰当前值与两端含义，不堆六级菜单和长段解释。Agent 页面在右侧「设定」，Human 页面从底部个人菜单进入，两个主体不混淆。保存反馈不改变窗口尺寸或闪出说明行。真实错误、冲突和危险确认保留，范围/下一份工作生效等细节放可访问描述和按需提示。

2026-10-02 后续重设计：头像统一为 64px、18px 圆角身份底座，默认既有 Logo 内缩 40px；上传图及 Human 首字按同一圆角框呈现，相机操作为 32px。身份先于总开关，表达偏好使用单一紧凑分组，系统模型与连接另组；全局和逐项仍是可键盘操作的真实 checkbox，不用图形开关另造保存状态。选中数值与含义收进同一标题行，没有选择时不显示备用数字；讲话风格、自定义内容和原保存／恢复链路保持。此阶段不修改 ROM、Host、默认 Profile 或用户资料，也不以视觉重设计补称已验证人格表现质量。

后续实际操作否决了手动保存方式和重复状态字：字段「已设置」只是草稿选中，但用户会合理理解为已经生效。现以 App 生命周期中的身份范围自动保存队列替代编辑器自己的手存草稿；全份开关置于名字前，明确包含名字和偏好。首次选择有效字段自动启用，整份关闭保留字段，编辑已停用值不自动开启；单项撤回仍是 `null`，0 的语义不变。空名字是编辑中间态，不能提交空名或无声删除旧已确认名；其他合法字段仍可独立确认。文本／滑杆合并连续意图，开关／单选直接提交；RPC 和读回仍使用原权限、CAS、不可变 command 与 Runtime ROM。Profile 与头像的每次 RPC 显式携带该 hook 捕获的身份 generation，不借全局 transport 后来观察的新身份；覆盖 bootstrap 已更新但 React 尚未切换的间隙。失败未确认的旧命令在本人重试前冻结，新修改排在它之后，不以新 ID 代替核对；冲突必须明确读取最新或确认覆盖。

普通新输入在 staging 之前排空当前身份的待保存意图并确认回执，避免直接提问先绑定旧配置；失败保留消息草稿，不创建或执行该输入。同一长期 Session 中普通输入本来就是不同 root／Thread，会读取当前有效 head，无需重建 Session 或放松 ROM 冻结。旧 Thread continuation 仍沿用原 manifest，新输入不改旧工作。初始全部未设置、单独开启空总开关和空文本准备编辑不提前建立 ROM；有效显式配置才建立首版。已经保存后的停用／清除仍按原语义写新的不可变修订，不删旧版本。成功不增加常驻「已设置／待保存」清单或底部保存区，必要错误与重试保留，32×20px 开关和头像尺寸不混用。这条取代此前「身份先于总开关／手动保存」交互，Runtime／Host 权威和 cache 边界未变。

头像更换操作默认不常驻素材上，桌面悬停／键盘聚焦时显示，无悬停触控设备保留入口；不修改上传、媒体或权限语义。开关鼠标焦点不再继承全局输入框的外圈，键盘焦点继续可见。静态上传头像就是静态；默认 Logo 不再具有卡通眨眼部件；用户动态图只是素材播放，不自称实时思考或语音生成。`prefers-reduced-motion`、非活动窗口、页面不可见时停装饰动画，动态图使用持久首帧。固定外框尺寸，不让任何状态更换造成抖动。

## 7. 阶段与验收

1. ROM：双后端 CAS/幂等/授权、canonical 限制、empty Context/prompt 字节兼容、Mind 不可改、Thread/Principal 精确绑定、恢复和缓存 fence；Rust/TS SDK 与 operator HTTP。
2. Host/Profile：同 typed read/write/proposal 边界、持久读回、跨身份/Team 隔离、头像格式与字节恢复、CAS/丢回执、backup/restore。
3. UI：Agent 起名/编辑、四个 0–5 和讲话风格、Human 名字/称呼/头像、真实上传与持久恢复；原创动态头像实看，轻暗/窄窗/键盘/减少动态/背景与状态切换无位移。
4. 原同一 Morphz 窗口：在确认无输入/听写/当前处理中后安全更新，核对原资料/消息/草稿/目录授权/审批和后台工作保留；不替用户改名字、权限或发送测试消息。隔离测试不能冒充原窗口的真实权限写入证据。

完成并验证一阶段后聚焦本地提交，不推送。设计、实现、隔离测试和实际原窗口证据必须分别写清楚；任何一项未完成，整体目标继续保持进行中。

## 8. 实施与验证记录

### 2026-10-02 设定页重设计验收

- UI 按身份、个性设定／表达偏好、能力与连接分层。Agent／Human 都采用 64px、18px 圆角身份底座，Logo 内缩 40px；上传资源、真实未设置／停用语义、CAS、失败草稿与保存读回不变。只在 Human 内嵌页脚阻止旧通用 dialog 样式泄漏，保持短窗完整保存操作。
- 最新构建 Profile／Dock 27／27、Avatar DOM／领域5／5、实际 UI→Host→Rust Runtime→Provider 请求4／4通过，20项原 Profile 回归保留。明暗、390px、200% CSS 几何与实际滚动后的完整 footer 已实看，不冒称原生 Electron 200% 测试；本轮未重复真实付费模型 probe。
- 原同一应用正常 Renderer Reload 后，Agent 与 Human 资料页均只读截图实看，全部未启用／不设置；恢复检查前的右栏收起状态，没有保存资料、上传头像、发测试输入或改权限。Runtime 仍为进程11395，本轮前后240个表逻辑摘要全部一致。审美为本轮交付试用，尚未获得用户认可；详细记录见[桌面实施记录](13-implementation-status.md)。

### 2026-10-02 显式设定修复验收

- Core／Host 本地提交 `9320a105`：24通过、0失败、1跳过；PostgreSQL 本轮环境未配置，未冒称验证。已保存 v1 原样、仅选字段 contract、0 与 null、关闭保留数据及头像、实际存储、权限、CAS和同命令重试均覆盖。
- 最新构建后的 Profile／Dock UI 26／26、Avatar 实际 DOM及领域5／5；明暗、390px、200%最终截图复看。未选项不展示预填数值；实际读回后才展示已启用／未启用，保存前为待保存。
- `playwright.profile-actual.config.ts` 的实际整链4／4通过：真实界面保存、实际HTTP Host、真实隔离SQL及Rust Runtime、实际Provider请求。只有Provider的确定性回答受控。幽默5／严谨0精确BODY、初始／关闭／全空无Profile及系统扩展、旧Thread继续固定revision1、真实提交后丢回执同命令重试、真实CAS409保留草稿、Human私有Principal仅称呼及关闭均实证。空风格／空称呼也经过实际UI保存，Client／Host统一null语义，不误报成功保存为冲突；最终构建UI26及Avatar5再次通过。
- `scripts/profile-real-model-probe.ts` 另在隔离Host／Runtime使用既有本机代理和实际 `gpt-6.1-sol`：3次请求依次回答「幽默配置：未设置。」「幽默配置：5/5。」「幽默配置：未设置。」，同时核对真正发出消息中的BODY存在／缺席。不包含原用户历史，不把模拟输出替换为这些回答，不宣称风格评分、所有模型一致遵循或上游缓存命中率。
- 原应用正常重开后截图／可访问树均确认默认Logo、整份未启用、各项不设置；未替用户写资料或头像。原可见未保存值仅私有备份，不把旧预填默认迁为新显式设置。原Runtime未重启，全部Runtime表逻辑摘要不变、17个Session与237个Thread及未来timer保留；12库备份、desktop与旧编译产物可恢复。具体表级验收边界见[桌面实施记录](13-implementation-status.md)。

### 首轮历史证据（不替代上方修复验收）

- Runtime 阶段本地提交 `dca1332a`：SQLite / 真实 PostgreSQL / 临时 workerd remote-store conformance 四项无跳过；实际 Context、Thread 版本绑定、只读、安全边界、空配置字节兼容、缓存契约与恢复均经过专门测试。TS SDK 9/9。另有真实 PostgreSQL 旧库升级回归。不是上游模型 prefix-cache 命中率实测，也未部署公共云 Cell。
- Host 阶段本地提交 `79dd6d83`：最终领域回归 89 项，88 通过、0 失败；唯一跳过是缺完整外部 S3 配置的云部署备份。另有 SQLite / 真实 PostgreSQL Platform 迁移回归 60/60。受控 S3 与两台真实 PostgreSQL Host 的双版本头像和 CAS 验证，不等于已验证用户的外部 S3 全量恢复。
- 真 Rust Runtime + HTTP / embedded Host smoke：实际保存名字、称呼和人格 ROM，原 command 幂等，重启同一隔离 Runtime 后读回保持；Team 双凭据的私有 Principal 隔离、gateway 无管理权、无 operator 时明确不可用、Team Agent 只读。全过程 Session=0、modelRequests=0，未对用户的实际资料试写，也未把模型个性表达效果当作已验证。
- 真实 Electron 44.2.0 / Node 24.20.0 中导入编译的 Host 和 sharp 0.35.5、首帧解码成功。头像解码和独立实际 DOM 状态动画 13/13；图片格式、预算、首帧、隐藏/减少动态和独立部件动作有实际证据，不仅检查 class 名。
- 凭据安全复查 13/13：非法 header、私有文件权限、环境注入、重连保留和异常脱敏；operatorToken 未进入 Renderer、工具、Runtime 持久投影或中心备份。真实 smoke 纠正了旧模拟中的错误 `/api/runtime/status` 假设，实际路由是 `/api/status`。
- 原窗口升级前：确认 AI 输入为空、听写关闭、无活跃 Activation / Job / 审批，仅保留 2026-10-23 的未来 timer。Runtime + 中心共 9 个 SQLite 已使用 SQLite backup 并逐一 quick_check=ok，另保存 desktop 和原受保护连接配置。备份路径 `runtime/backups/profile-rom-preupdate-WLAI1Xbs` 位于同一开发数据目录。
- UI 在实际浏览器渲染中验证明暗、390px 与 200% CSS 缩放；发现并修复通用 modal 把已缩放 DOMRect 再写成 CSS offset 导致二次缩放。新个人资料入口不改变展开上方 / 收缩右侧菜单规则，保存与恢复保留真实输入草稿。
- Profile UI 最终 18/18，通过 typed transport 受控回归验证四个特性的全部分值、保存读回、丢回执同 command 重试、显式 CAS 恢复、真实图片解码和 Blob 撤销。Team 登录与身份切换使用实际应用身份流程，Profile RPC 受控；不是 UI 到真实 Rust Runtime 的一条端到端保存证据。既有个人菜单、连接和界面一致性回归 17/17，其余推理、设置、对话框和 Logo 回归 14 项通过。明暗、390px 和 200% 的八张截图已逐一复看。
- CAS 冲突保留自己的草稿，只在用户明确选择「使用最新」或「保留修改」后刷新基线，再次保存才写入；未知提交结果则继续复用原 command。明确 401/403 后隐藏旧资料并撤销头像 URL，随后 503 不能当作恢复授权，必须重新成功授权读取。两项独立复查均已回归。
- 最终 TypeScript / Vite / Host build 成功。原 `/Users/shafreeck/Applications/Morphz.app` 正常退出后以同一中心、桌面数据和 Runtime 配置更新，没有新增一套应用实例；Runtime 授权 `/api/status` 返回 200。实际库 quick_check=ok：Session 17、消息 385、Thread 230（219 completed、9 cancelled、1 failed、1 open）与升级前一致，230 个旧 Thread 确定绑定空 ROM；用户 ROM heads=0、头像 heads=0，未替用户保存任何资料。Platform 已从 v9 升级 v10。8 项已派发安排和 1 项未来排队安排保持，唯一待触发 timer 仍为 `2026-10-23T01:00:00Z`。
- 原 Electron 窗口实看：Agent「设定」有头像、起名引导、四个特性、讲话风格和可用的保存；Human 菜单「个人资料」有本人名字、希望的称呼和头像。未点击保存、上传或改变权限，检查后关闭个人资料与右栏，恢复原来的对话位置。输入为空、听写关闭。执行设置展开与收起都显示「默认」，而不是把继承的轻量当作显式选项；「询问批准」显示人物盾牌，不再为空盾或问号。
- 原生头像已接真实 focus/blur、document.hasFocus 与 visibility；隐藏和减少动态的实际 DOM 退化验证通过。自动化浏览器的焦点模拟未能提供可靠的真实失焦/恢复证据，严格 headed 诊断未计为通过；原 Electron 失焦暂停尚未单独实证。未测真实模型不同分值的主观表达效果、外部 S3 全量恢复或上游 prefix-cache 命中率，不将这些称为已完成的验证。
- UI 本地提交 `1829f8dd`。最后复查发现旧 desk 持久标题还会从活动/详情/审批来源和内容归属显示出来，现以 `kind=desk` 在显示层称为「无项目」，不重命名持久标题或 ID，也不改历史用户输入。最终重新构建后通过原应用 View → Reload 正常刷新，实际旧提醒和近期活动均显示「无项目」，`TEST 0930` 等真实项目仍显示原名；检查后再次收起右侧栏，原输入与听写状态未改变。
- 最后完整主体栏 / 应用 Dock UI 回归 6/6，显示 helper 与执行活动单测 11/11，TypeScript 和 diff 检查通过。静态设定 tab 的旧品牌测试更新为实际 18px ProfileAvatar、左侧品牌轮廓不变、所有后代无动画，保留原无写入、Session 和草稿断言；活动来源回归使用真实隔离 Host 的 desk 数据，前后完整持久对象一致。旧 mock teardown 的在途 route.fetch 在该测试套件以 unrouteAll(wait) 排空，不吞异常。
