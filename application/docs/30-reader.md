# 阅读认知应用：实施与验收约束

状态：功能代码已实现，自动化回归通过；原 Morphz 窗口手动验收进行中，尚不能宣布整体完成。2026-09-23 用户将原 EPUB 目标扩展为常见阅读格式，并要求核对开源 PDF 解析与 OCR 方案。本文区分实现、自动化证据、实际窗口证据和未完成项。

## 产品闭环

工作台「阅读」→ 导入或打开已有内容 → 阅读、书签、高亮、批注 → 选文向 Morphz 提问 → 从消息引用返回原位置 → 下次继续。

- 一个阅读应用，不按格式拆成多个助手或空间。文件仍是同一个内容对象，项目只改变归属，不复制书籍。
- 复用已有统一 Session、Agent、Context/Mind、权限、浮动交流区和发送/流式/停止/重试链路；不增加一套读书聊天或记忆库。
- 原文是主画布；目录和笔记可收起。一个紧凑的标题/操作栏，避免叠加书籍标题、页标题和大块空白。
- 选文只准备引用和问题，不代替用户发送。书签/划线不启动模型。失败保留原问题、引用、位置和重试身份。
- 未归项目和项目内容都能从阅读与全局内容入口找到；不得重新引入「对话存储空间」。

## 格式与分层

| 格式 | 当前实现 | 边界 |
| --- | --- | --- |
| EPUB 2/3 | OPF/spine、NCX/nav 目录、安全语义重排、内嵌图片、章内/跨章链接 | 不保留出版社任意 CSS，不是固定版式/DRM 阅读器；不宣称完整 EPUB 规范兼容 |
| PDF | 原页与文字层、按页定位/标注、无文字层提示、显式本地 OCR | 不执行 PDF 脚本；扫描页未识别前不假装已有文字 |
| Markdown | 标题目录、GFM 表格/列表、跨章脚注 | 原始 HTML 不执行；远程资源不自动加载 |
| TXT | UTF-8/UTF-16、段落分节 | 未支持的编码明确报错，不用乱码冒充成功 |
| DOCX | Mammoth 语义内容、标题、段落、表格与内嵌图片 | 非 Word 像素级排版，宏/外部资源不执行 |
| HTML | 清理后的正文、内嵌图片、安全内部链接 | 禁脚本、表单、iframe 和外部网络资源 |
| DOC / RTF | macOS 系统 textutil 有界子进程转换文字，原文件保留 | 仅文字，不保留排版/图片；其他主机明确提示另存为 DOCX/PDF/TXT |

文件上限 32 MB；结构化读物最多 2,000 节、总文字 800 万、单节 100 万。
这是列明格式的首版，不包括扫描图片导入、ODT、演示文稿或所有文档变体。

1. 展示层负责原页/重排、目录、缩放或字号、选文和定位，不依赖 OCR 完成才能打开文件。
2. 解析层负责可核实的文本、结构、阅读顺序和来源坐标；文本型文档不重复跑 OCR。
3. OCR 是扫描 PDF/图像的识别层，保留原页，不把识别文本当作原文或覆盖原文件。显式显示处理中、失败、低置信度与取消状态。
4. 阅读状态、私人标注、具体选文讨论各自持久化。OCR 再识别不静默改变既有引用或标注的依据版本。

## 开源方案核对（2026-09-23）

通过 agent-reach 的官方仓库访问和网页搜索核对；未将上游榜单当作 Morphz 实测。Exa 未配置，未为调研修改搜索服务或安装第三方 Skill。

| 层次 | 候选与已核实能力 | 本项目处理 |
| --- | --- | --- |
| PDF 展示 | 已依赖 PDF.js，可显示原页并取得文字层 | 已复用原页能力，增加定位与标注；OCR 是独立衍生文本，不替代原页 |
| EPUB 展示 | [epub.js](https://github.com/futurepress/epub.js) BSD-2-Clause；[foliate-js](https://github.com/johnfactotum/foliate-js) MIT，提供分页、CFI、标注层且无稳定发布承诺 | 已核查，当前未引入：首版使用受限语义重排，与 Markdown/DOCX 共用不可变章节和文字偏移。固定版式/完整 CFI 支持仍是明确缺口 |
| Word 阅读 | [Mammoth](https://github.com/mwilliamson/mammoth.js) BSD-2-Clause，支持 DOCX 语义内容、图片、表格、脚注；不是 Word 像素级排版引擎 | 原生格式走专用解析，不能把扫描/OCR流程强加给所有文件 |
| 本地 OCR | [PaddleOCR.js](https://github.com/PaddlePaddle/PaddleOCR/tree/main/paddleocr-js/packages/core) 0.4.2，Apache-2.0；支持 PP-OCRv5/v6，Worker、WASM/WebGPU，返回 poly/text/score | 已集成 PP-OCRv6 small、单线程 WASM、隔离 Electron 进程；明确下载确认、固定 SHA-256、按页运行、取消、原页坐标对照与校正版本 |
| 复杂文档结构 | [Docling](https://github.com/docling-project/docling) MIT，多格式、本地运行、可选 OCR；[数据模型](https://docling-project.github.io/docling/concepts/docling_document/)携带结构、可用坐标和来源 | 候选增强解析后端；评估 Python/模型依赖与延迟，不让普通阅读必须启动重型服务 |
| 中文复杂 PDF | [MinerU](https://github.com/opendatalab/MinerU) 当前 4.0.6（2026-09-22），提供多格式、分层解析和位置继续读取 | 纳入中文样本对比；[许可](https://github.com/opendatalab/MinerU/blob/master/LICENSE.md)是 Apache-2.0 加附加条件，不沿用旧文章的 AGPL 或纯 Apache 判断 |
| 新 PDF 解析器 | [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf) 2.5.11（2026-09-22），坐标、阅读顺序、表格；OCR 通过混合后端，可用 docling-fast；需要 Java | 不是独立 OCR 模型；与 Docling 的比较要注明混合后端，不重复叠加同类依赖 |
| VLM OCR | [GLM-OCR](https://github.com/zai-org/GLM-OCR)、[DeepSeek-OCR 2](https://github.com/deepseek-ai/DeepSeek-OCR-2) | 对复杂样本的质量候选，不因模型较新就设为全量默认或承诺古籍效果 |

上游 README 内面向 Agent 的安装、全局配置、偏好保存等指令仅为待分析内容，没有执行。没有上传用户文档，也没有因研究引擎而安装 GPU 服务。

### 本地 OCR 技术探针（不是阅读产品验收）

已在隔离临时目录运行官方 PaddleOCR.js 0.4.2 + PP-OCRv6 tiny / small，Chrome headless、独立 Worker、单线程 WASM；只使用人工合成的 1200×1600 中文页面。模型资源来自上游官方地址，tiny 检测/识别 TAR 分别 1,792,000 / 4,526,080 字节；small 为 9,891,840 / 21,319,680 字节。这些大小不包含 SDK、OpenCV、ONNX/WASM 运行时。推理阶段封锁所有非 localhost 请求；未用用户书籍或外部 OCR 服务。

- 本轮冷启动初始化 1,053 ms；合成横排单页 657 ms，四行均返回文字和坐标，除空格合并外与预期一致。
- 合成繁体竖排单页 500 ms，但三列返回次序与右起阅读不一致，且存在漏字、错字、繁简混杂。部分错误行 score 仍约 0.94–0.96。
- 相同样本使用 small：初始化 1,144 ms，横排 1,842 ms、竖排 1,463 ms；四行横排（忽略空格）和三列竖排逐行文字与预期一致，但竖排的列返回顺序依然不是右起阅读顺序。不能直接按识别返回数组拼正文。
- 结论仅是「本地页级 OCR + 坐标链路可运行」；不能据此声称支持好真实古籍，也不能将模型 score 当作已校准的正确率。不能用一个低置信度阈值代替原页核对、版面方向和人工纠正。
- 该探针不涵盖真实扫描、页变形、表格、全本性能、内存、原 Morphz 窗口或用户输入流程；这些仍在下面的验收清单中。

这轮早期探针和下载的模型只在临时目录 `/tmp/morphz-reader-ocr-7S5KFL`，没有放进仓库或原 Morphz 配置。数据集仅上述两张合成页面、每个模型每页一次测量；数字不是性能承诺或统计评测结论。之后已将 small 接入下面的真实 Desktop 生产入口自动化链路；不把两种测量环境的时间混为一谈。

### 已集成的 OCR 路径与测量

在扫描 PDF 页展开识别入口 → 选择横排/左右双栏/右起竖排 → 首次明确确认下载约 31 MB → 后续离线识别当前页 → 原页和可选择文字并列 → 必要时逐行校正 → 高亮/批注/提问。

- 模型缓存固定大小、SHA-256；模型下载仅 GET，不携带文档、应用凭据或 Cookie。
- 推理窗口是临时隔离会话，无主应用 API、个人档案、权限或网络访问。OpenCV 所需 `unsafe-eval` 只放宽该窗口，不改变主应用 CSP。每次限一页/一个引擎，90 秒上限；取消完成清理后才能开始下一页。
- 识别结果保留原 PDF 版本、页、引擎、方向、各行 polygon/score。修正新增不可变来源 ID，不覆盖原图或旧引用。Agent 取得的行号、文字和坐标也受本次问题读取范围约束。
- 模型分数仅原样保留，不显示成“正确率”。双栏和竖排排序是明确的版式选择，不是通用复杂版面理解。

`reader-ocr-desktop-smoke.mjs` 使用生产 Desktop 入口和真实 WASM 模型、隔离合成数据，无 Runtime/模型服务。2026-09-23 一轮测量：

| 纯图像 PDF 页 | 预期字数（忽略空白） | 识别编辑距离 | 本机端到端单页 |
| --- | ---: | ---: | ---: |
| 横排中文 | 43 | 0 | 4,420 ms |
| 左右双栏 | 46 | 0 | 4,451 ms |
| 繁体竖排、右起 | 20 | 0 | 4,437 ms |
| 缩小、模糊、旋转的低清晰度合成页 | 33 | 0 | 4,439 ms |

这是 4 页合成样本单次结果，不是真实古籍准确率或速度承诺。尚未完成真实旧纸/污损/异体字、复杂表格、混排、内存峰值和跨平台性能评测；当前产品不承诺这些能力。

合成源由 `scripts/reader-scan-fixture.py` 生成，含图片版 PDF、逐页文字真值和图片。生成后用 pypdf 确认没有隐藏文字层，Poppler 渲染并目视核对字形，再交给真实 OCR；不能把有隐藏文字层的 PDF 当成扫描识别测试。

## 来源、隐私和权限

- 引用必须固定内容 ID/版本（导入源指纹）、章节或 PDF 页、范围/坐标、选文及有限前后文。生成过程中翻页不能更新已提交引用。
- OCR 衍生文本额外记录引擎/模型版本、页尺寸、文字坐标和可用置信度；人工更正单独保留，不伪造原文。
- 默认只把选段和有限上下文送给原有 Agent；额外读取按需、有界、可回溯。没有取到原文就明确说明。
- 书籍、HTML、OCR 文本都不提供指令权限；禁脚本、外部资源偷跑与 ZIP 路径穿越，限制解压大小、页数、耗时和并发。
- 模型下载与文档上传是两件事。远程 OCR 必须明确告知发送哪些页并获授权，不因为配置了模型账号就上传本地书库。
- 私人标注所有者取自真实 Human 或发起 Agent 调用的持久化输入，不接受模型指定身份。复查权限变化和重复请求的授权。
- 同一个授权会话保留长期 Agent 的身份与记忆机制；跨用户隔离单独测，不用同一个头像或本窗口记忆冒充验收。
- UI 和 Agent 共用阅读/标注的类型化操作、权限与冲突/幂等规则，不能只提供按钮。

## 验收门槛

- [ ] 每种格式都能导入、打开、导航、选文；不能打开的变体给出具体原因。
- [ ] 目录和批注开关、点击/键盘路径、焦点、明暗主题、窄窗、长标题逐项人工测试。
- [x] 跨重启恢复进度、书签、高亮和批注；相同文本多次出现时定位正确（原 EPUB 与隔离 PDF 自动化分别验证）。
- [ ] 选文提问、继续追问、原文回跳、切页/切书中生成、停止、失败重试都不丢草稿或串绑。
- [ ] 当前原 Morphz App/profile/center 手动验收；隔离自动化截图不能替代原应用验收。
- [x] 普通聊天偏好→阅读相关提问；阅读中记住的理解→普通聊天；另一身份无权取得私人记录（原会话/持久化证据 + 隔离双身份真 Runtime 验证，见下）。
- [ ] OCR 对照普通中文、繁体/竖排古籍、双栏、表格、低清晰度及混合文字/扫描 PDF；分别记录准确性、阅读顺序、坐标、首屏耗时、内存和失败行为。
- [ ] OCR 首次加载、页级取消、缓存复用、重新识别版本、不确定文字核对和离线状态可见；滚动不能自动启动整本 OCR 或模型请求。
- [ ] 不把供应商速度/排名当本机实测；无法稳定识别的情况在 UI 和交付说明里如实写明。
- [ ] 聚焦提交本轮代码，排除用户书籍、凭据、运行数据、既有剧本与网站未提交改动。

### 当前证据（2026-09-23）

- `npm test`：当前工作区 380 项通过；排除既有未提交剧本/网站改动的暂存快照单独运行，379 项全部通过，类型检查通过。阅读专项覆盖格式导入、ZIP/XML/资源边界、重复文字定位、不可变来源、伪造引用拒绝、防剧透、有界 OCR 行元数据、实际发起 Human、跨身份私有标注隔离、撤销/冲突和持久化；新增未加载 v6 时保留原请求与引用、原样重试，以及 Host 描述 UTF-8 字节上限回归。
- `npm run build`：类型检查和生产构建通过。OCR 为独立懒加载页面，正常对话不加载其大型运行时。
- `tests/e2e/reader.spec.ts`：Web 自动化验证 Markdown/PDF 的导入、目录、选文、高亮、批注、进度恢复、固定引用、统一 Session ID、消息回跳和窄窗。该测试未连接 Runtime，不是模型连续性证明。
- 生产 Electron OCR 自动化已验证真模型、逐行校正、原版本保留、重开恢复、合成扫描矩阵和取消；夜读和 200% 原生缩放也已通过实际合成窗口截图检查。隔离窗口无 Node/主应用 API，访问工作中心返回 403，外部网络被拒绝。这些截图不是原用户窗口手动验收。
- 原 Morphz App、原 profile、原 center：已手动验证 EPUB 导入、两章导航、跨章注释回跳、选文高亮、批注保存、主题切换、返回读物恢复和选文准备到原输入框。备份数据库后正常重启，未清空/更换用户资料。
- 原普通聊天 06:16 确认了明确标记 TEST 的回答顺序/暗号约定；07:07 在原阅读请求中沿用，显示实际回答。等待生成时从引用跳到第一章，再翻到第二章，提交的引用仍固定在第一章。原问题首次因旧 Runtime 未加载 v6 失败；原输入 ID、问题和引用保持不变，重载后点击原「重试发送」完成，没有重复新发。
- 实际 `context_tx` 将合成理解写入原 Context 的 `synthetic-reading-0923-evidence`，revision 1、Mind version 15，含原书名、章节、引文、artifact/revision/sourceId/sectionId/start/end 和来源事件；明确不是书中事实或真实个人标签。普通对话、伴读、07:09 返回普通对话三次请求使用同一个 Runtime Session。最后一次输入不含阅读引用且不复述理解，实际回复正确取回理解和来源，Mind frame revision 未改变。最后回复的后台结果已核实，但 Mac 再次锁屏，尚未目视核对这一条在普通对话窗口的最终渲染。
- `runtime-ipc-smoke.ts` 使用相同 Runtime 二进制、独立临时数据库/合成模型服务：真实装载 reading v6、接收固定引文、执行 Host 工具、产生准确输入回执，并验证重开宿主和重试已接收请求不重复调用模型。它发现阅读工具介绍超过 Runtime 的 16,000 字节限制，已精简为按需发现入口而非放宽底层限额，复测通过。
- `reader-session-desktop-smoke.mjs` 使用生产 Desktop 入口、真实 Runtime 和可控合成流：结束前实际渲染增量文字，交流区展开不挤压阅读画布；生成中翻到第二章、重新打开交流区，引用仍为第一章。点击实际停止按钮后，Runtime 确认 cancelled、模型连接关闭、已显示文字及引用保留；从引用回跳并继续提问，完成第二次回复。SQLite 中两条输入均为 v6、具有不同 root 和相同非空 Session ID；只发生两次模型调用，无重放。原窗口仍待人工复验，这条自动化不冒充原窗口证据。
- `runtime-identity-smoke.ts` 双身份真 Runtime 验证：真实 `context_tx` 写入两份合成来源理解；本人可读，另一身份读取 Session/Context projection 返回 403，管理面 frame recall 对用户网关返回 401；同时验证模型上下文隔离、共享项目的明确共享边界、身份撤销和重开。只使用合成凭据与模型，未切换/冒充原 Desktop 用户。
- 实际窗口发现并已在代码修复：后台刷新替换正文 DOM 打断选文、Portal 工具条默认黑边、批注弹窗未继承共享样式、夜间链接对比度。200% 自动化又发现 PDF 缩放取消与文字层提取之间的未处理拒绝，已修复并复测；文字层重绘清理、防重复及连续调整窗口也有回归。原窗口已正常重启至修复构建，章节恢复为第二章；全部视觉修复、PDF/OCR 与停止按钮的最终手动复验仍待解锁。

### 代码与运行

- `packages/core/src/reader*.ts`：阅读上下文、类型化操作、不可变 OCR 来源和布局排序。
- `packages/application/src/reader*.ts`、`store.ts`：有界解析 Worker、持久化、权限、模型缓存和 Agent 工具。数据库 schema 15；阅读正文按节读取，不塞进频繁 workspace 快照。
- `apps/web/src/Reader*.tsx`：同一个阅读应用、书库/原文/笔记/引用；`reader-dom.ts` 对齐真实 DOM 与规范文字偏移。
- `apps/desktop/reader-ocr*.cjs` 和 `apps/web/ocr.html`：一次性隔离 OCR 进程；Web/远程服务无本地引擎时明确提示，不悄悄调用云 OCR。
- `session-io.ts`：沿用既有 Session/Agent/记忆链路；新输入固定 reading v6 引用，已存旧消息格式不改写。书籍内容明确为无授权的外部资料，不新建读书 Agent/Mind。

在 `application/` 执行 `npm run build`，使用原有 Desktop 启动方式。入口为工作台 → 应用 → 阅读；不要另启一套 Runtime、手动测试 profile 或工作中心。库中已有 PDF/Markdown 仍是同一个内容对象；新导入保存原文件和固定阅读来源。

独立 Runtime 仅在启动时加载 `MORPHZ_HOST_TOOLS_FILE` 中的格式与工具定义；更新 Desktop 写出新 manifest 不代表旧 Runtime 已加载。部署时先确认无在途执行，保留原配置/凭据/数据库，通过该部署的原启动入口正常重载 Runtime，再核对 `/api/session-io/capabilities` 中的 `morphz.application.input@6`。不得为规避检查把引用改成普通提示词、另建 Session 或启动第二个 Runtime。本次原服务已按此完成，身份、模型和三个配置文件哈希不变；数据库备份经 integrity_check 核验。

可重复验证命令：

```sh
npm test
npm run build
npx playwright test tests/e2e/reader.spec.ts --workers=1
npm run test:runtime-ipc
npm run test:runtime-identity
npm run test:reader-session
node scripts/reader-fixtures.mjs /absolute/synthetic-fixture-directory
node scripts/reader-ocr-desktop-smoke.mjs /absolute/model-fixture-directory /absolute/synthetic-scan-directory
```

最后一项要求显式提供已校验的 `small-det.tar` / `small-rec.tar`，不会查找用户书库或配置。扫描生成器需要 Python 的 Pillow/reportlab/pypdf 和调用方提供的中文字体；字体与书籍均不提交。

### 许可与未完成项

已同步锁文件依赖的 `THIRD_PARTY_LICENSES.md`，保留 ONNX Runtime、PaddleOCR、OpenCV、Clipper/JSBN 等声明；版本和补充来源见 [`third_party/licenses/reader-ocr-UPSTREAM.md`](../../third_party/licenses/reader-ocr-UPSTREAM.md)。PP-OCRv6 small 的[检测](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det)与[识别](https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec)模型卡均声明 Apache-2.0；模型二进制未提交。

必须继续：原窗口修复复验、PDF/OCR 导入与操作、普通聊天最终渲染和停止交互。更多真实 EPUB/Word 排版样书、真实古籍/表格/混合 PDF、跨平台和性能评测是明确未覆盖的质量范围；首版不得承诺固定版式还原、古籍无误识别、复杂表格理解或全部文档兼容。格式表所列限制要继续保留在交付说明中，不能把“库支持”或“合成样本正确”描述为全部产品验收完成。
