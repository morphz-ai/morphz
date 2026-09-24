# 阅读与统一消息：继续验收记录（2026-09-24）

本轮接续剧本体验收尾提交 `2f890528`，只处理阅读、统一选文评论和消息链路。不是全产品、全部文档变体或真实模型回答质量的完成声明。

## 发现并修复

1. **Host 工具说明仍要求不剧透。** UI、输入和读取检查已经移除这项策略，`host_morphz` 的 description 却还有 `no-spoiler limits, even from prior knowledge`。现直接删除该要求，按问题读取前后文；不增加兼容分支。回归同时检查工具定义及真实 Runtime 发给合成 Provider 的请求，不再只检查阅读设置。
2. **PDF 的两个入口上限不一致。** 阅读入口写 32 MB，但复用的 PDF 解析器仍按 20 MB 拒绝，公开的 24.21 MB 扫描本实际导入失败。PDF 导入现在引用阅读的同一大小常量；内容导入界面、Web HTTP、Desktop 业务调用和解析器一致。32 MB 边界、超过边界不创建对象、跨入口同命令不重复保存均有回归。消息附件仍是原独立 20 MB 边界，本轮不改附件或目录授权读取范围。
3. **阅读 Session 冒烟测试停留在旧交互。** 选文已进入统一评论框，旧测试却直接填主输入框。更新为「解释这段 → 检查就地评论 → Escape 收起 → 共享输入发送」，校验真正持久化的 `textQuotes`、对应评论和稳定来源，未为让旧测试通过恢复冗余 UI。

前两项均先有失败证据，再作修复。PDF 的页数、文字量、Worker 内存和解析超时边界未放开。

## 本轮结果

| 验证 | 结果与范围 |
| --- | --- |
| 单元／集成 | 397/397 通过，包含完整 32 MB PDF 的 Desktop 业务与 HTTP 导入 |
| 构建 | TypeScript、Vite、服务端编译通过 |
| 阅读／PDF／统一评论界面 | 23/23 通过，覆盖格式矩阵、高亮取消、评论恢复、回跳、失败原样重试、窄窗与明暗主题 |
| 百万字阅读 | 合成 Markdown 1,038,982 字符、25,000 段、87 节；只加载当前节，workspace 只含目录；末章跳转和刷新恢复通过 |
| 大读物单次本机测量 | 导入到正文出现 2,583 ms；24 次滚动各等待两个动画帧，中位 33.3 ms、P95 35.1 ms；不是跨机器性能承诺或内存峰值测试 |
| 真实 Runtime ＋生产 Desktop | 流式、停止、刷新和两端重启后部分回复恢复、同 Session 继续、固定来源和按需 Host 读取通过；4 次调用全部是本地可控模型，不是付费模型 |
| 本地 OCR 合成矩阵 | 横排、双栏、繁体竖排、模糊旋转 4 页编辑距离均为 0；单页 4,425–4,458 ms；取消、校正版本、重开、进程隔离、夜读与 200% 缩放通过 |
| 原应用重载 | 双库在线备份并通过完整性检查，无在途工作后正常重开同一 App/profile/center 和同一 18089 Runtime；新工具说明已加载 |
| 数据保留 | 原 91 条输入、9 部剧本、44 个内容对象、9 条阅读标注以及所有工作区集合逐项哈希一致；原四条引用草稿仍在，配置／凭据和格式／Harness 清单未变 |

未向原会话发送新测试消息，没有使用用户书籍或上传书库，没有推送或发布。

## 真实古籍 OCR：能运行，不等于质量通过

样本是郭嵩焘《使西紀程》清代刻本，来自 [Commons 原始扫描 PDF](https://commons.wikimedia.org/wiki/File:NLC892-GBZX0301010751-250698_使西紀程_二卷.pdf)。共 60 页，25,383,067 字节；该公开扫描标记为公有领域。只在隔离测试中心导入，没有加入用户书库，原 PDF 和模型均不提交到 Git。

- SHA-256：`661e228b5337a8719b8c05d9d4de6805daeb9dfbcb31007c780b73f8c6d83543`。
- pypdf 确认第 3 页只有一张图像、提取文字为零；Poppler 渲染后目视检查竖排、折痕、印章及字形。调研首选 Exa 服务未配置，改用公开网页与原文件，未安装或改动搜索服务。
- 对照 [维基文库第 3 页校对文本固定版本](https://zh.wikisource.org/w/index.php?title=Page:NLC892-GBZX0301010751-250698_使西紀程_二卷.pdf/3&oldid=2537413)，并以扫描页核对。主文真值不含印章、版心重复标题与馆藏号；比较以 Unicode 码点计数。
- 生产 Desktop、本地 PP-OCRv6 small、右起竖排：第 3 页 5,536 ms。主文对照 285 字符、编辑距离 40；包含印章杂字和版心文字，不把这个比例称为已校准的字符错误率。
- 明确存在标题／姓名错误、印章杂字、`雨` 误为 `兩` 等错漏。原页、识别文本和校对版本保留，但**真实古籍自动识别质量未通过**。没有将这些错误静默删掉，也没有用模型分数包装成正确率。
- 取消、重开、旧识别版本保留、夜读与 200% 缩放等工作流程通过，不改变上述质量结论。复杂表格、混合排版及更广样本仍未评测。

OCR 测试现在接受显式样本清单：文件路径、来源、标题、校验和、页码、版式及对照文字。不再把真实扫描样本标成「合成样本」。合成清单逐页要求编辑距离为零；真实样本只记录测量，输出 `accuracyAsserted: false`，不会把脚本正常结束冒充质量通过。

## 复现与本机证据

在 `application/`：

```sh
npm test
npm run build
npx playwright test tests/reader-recovery.spec.ts tests/e2e/reader.spec.ts tests/pdf.spec.ts tests/pdf-attachment.spec.ts tests/text-quotes.spec.ts
npm run test:reader-session
node scripts/reader-ocr-desktop-smoke.mjs /absolute/models /absolute/scan-manifest.json
```

合成扫描生成器 `scripts/reader-scan-fixture.py` 输出 `scan-manifest.json`；需要调用方提供能实际显示简繁文字的字体与正确的 TTC face index。公开样本清单的 `source` 与固定校验和保留出处；不下载或读取任意用户目录。

本机日志前缀 `/tmp/morphz-reader-followup-20260924-`：`unit-final.log`、`build-final.log`、`ui-final.log`、`session-final.log`、`ocr-synthetic-final.log`、`ocr-public-scan-final.log`；失败证据有 `policy-red.log`、`pdf-limit-red.log`。截图／性能 JSON 位于 `application/test-results/reader-followup-final-20260924/`。原应用双库备份及校验在 `/tmp/morphz-reader-followup-live-pwyHHY/`，均不提交。

待办：使用真实古籍／现代扫描／表格固定样本比较识别与版面处理方案，并保留原页回溯；不能只围绕单页做启发式删字来“提高成绩”。本轮没有新增云 OCR、后台扫描或付费模型调用。
