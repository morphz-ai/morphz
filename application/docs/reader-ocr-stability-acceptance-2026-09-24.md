# 阅读 OCR、资源释放与草稿恢复：继续自动化（2026-09-24）

接续[前轮阅读验收](./reader-followup-acceptance-2026-09-24.md)，本轮限定为本地 OCR 质量对比、阅读反复操作、草稿恢复和 CI 回归。不新增阅读策略、云 OCR、后台扫描或付费模型调用；不重写 Runtime。

## 修复的实际问题

1. **同一行的表格内容被打乱。** 原横排排序直接比较字框顶部，几像素检测偏差就会把中间单元格排到第一列之前。现按字框中心及较短字框高度分行，行内从左向右；分组使用固定基准，避免模糊比较不满足传递性。显式双栏分别使用同一规则，竖排规则未改。保留全部文字和坐标，不按置信度删字。这只是顺序修正，不是复杂表格语义重建。
2. **相同扫描因 PDF 物理尺寸较小而渲染不足。** 原 `2.5` 倍上限将公开样本渲染为 1152×949，未用足已有像素预算。现在最长边统一为 2000，仍不超过原像素预算；拒绝无效尺寸。引擎标识加入渲染／排序配方，避免新结果复用旧配方缓存；既有不可变识别来源及其引用保持可读，不改写历史。
3. **关闭 OCR 窗口并不代表 PDF／模型缓冲区已释放。** 150 轮中页面对象和 Worker 正常退出，但主进程 `external` 持续增长至约 8.54 GB。额外 12 轮及主进程 GC 复现：退出书籍后仍有 683,653,300 字节。隔离分区可比窗口活得更久，现于结束时释放回调闭包中的本轮请求数据，完成、取消、失败均清理。相同 12 轮，回收后降为 4,518,256 字节；不向生产路径加入强制 GC。单元测试模拟仍保留回调的分区，结束后不得再读取模型；真实 Desktop 测试同时检查缓冲区增长。
4. **旧地址的草稿可能抢走当前窗口归属。** 原启动恢复将“没有正文、选文或附件”当作空草稿，遗漏独立引用，并可能用旧 HTTP 地址的窗口覆盖当前已保存窗口。现在当前地址的窗口标记始终优先，包括只有引用或已清空的输入；缺少标记时识别引用／意图草稿。不增加兼容别名或新的草稿存储。

顺序与恢复分别有先失败后通过的回归。内存红测取自实际 12 轮报告，不以 mock 或 RSS 单项替代。

## OCR 测量与质量边界

六页**纯图像**合成材料由 `reader-scan-fixture.py` 生成，Poppler 渲染检查后交给生产 Desktop 和真实本地 PP-OCRv6 small。模型、PDF、图片及识别全文不提交到 Git。

| 样本 | 对照字符数 | 编辑距离（仅忽略空白） | 本机单页耗时 |
| --- | ---: | ---: | ---: |
| 横排中文 | 43 | 0 | 4,672 ms |
| 左右双栏 | 46 | 0 | 4,400 ms |
| 繁体竖排 | 20 | 0 | 4,431 ms |
| 模糊、旋转 | 33 | 0 | 4,507 ms |
| 简单三列表格 | 42 | 0（修复前为 12，主要是次序） | 4,461 ms |
| 小字中文／Latin／数字 | 153 | 0 | 5,410 ms |

真实样本仍为公有领域的[郭嵩焘《使西紀程》扫描本](https://commons.wikimedia.org/wiki/File:NLC892-GBZX0301010751-250698_使西紀程_二卷.pdf)，60 页、25,383,067 字节，SHA-256 `661e228b5337a8719b8c05d9d4de6805daeb9dfbcb31007c780b73f8c6d83543`。仅在隔离测试中心导入。

- [第 3 页固定校对版本](https://zh.wikisource.org/w/index.php?title=Page:NLC892-GBZX0301010751-250698_使西紀程_二卷.pdf/3&oldid=2537413)：285 字符，旧渲染编辑距离 40，新配方生产链路 34，6,519 ms。
- [第 4 页固定校对版本](https://zh.wikisource.org/w/index.php?title=Page:NLC892-GBZX0301010751-250698_使西紀程_二卷.pdf/4&oldid=2537414)：330 字符，旧渲染探针 13，新配方生产链路 12，6,645 ms。
- 对照正文不含印章和版心标题，OCR 输出却保留这些内容，因此这些数值**不是已校准字符错误率**。仍有姓名、繁体字和杂字错误，真实古籍自动转写质量未通过。
- 研究探针比较原渲染、统一 2000、较高分辨率、检测尺寸、框扩张参数五种配置，没有稳定证据支持提高默认预算。探针只作方案比较；生产流程另由真实 Electron 复核。

## 自动化范围

| 验证 | 结果与边界 |
| --- | --- |
| 构建／类型检查、全量单元集成 | 405/405 通过；构建仍有既有大 chunk 警告 |
| 阅读／PDF／统一选文界面 | 23/23 通过，沿用前轮回归，未改 UI 交互 |
| 生产 Desktop 嵌入冒烟 | 通过；纠正过时的项目内容按钮与 PDF 下一页选择器，未降低业务断言 |
| 草稿跨完整退出恢复 | 通过；四条独立引用、空输入、存在旧 HTTP 草稿的情况，原值／窗口身份不变，不发送消息 |
| OCR 生产矩阵 | 六页合成样本通过；真实古籍仅记录质量，不以脚本退出成功冒充质量通过 |
| OCR 隔离／校对／取消 | 无 Node、无主应用 API、应用数据读取 403、外部网络拒绝；校对新增来源、旧来源保留、刷新恢复、取消通过 |
| 150 轮循环 | 100 次真实 OCR、50 次取消，60 页公开 PDF 反复翻页／往返启动台；约 11 分 18 秒。OCR 窗口每轮归零，离开书籍后 PDF Worker 归零，刷新与完整重启保留位置及旧来源；此轮暴露主进程缓冲区泄漏，**不能记作完整内存验收通过** |
| 内存修复后 12 轮 | 同一公开 PDF，8 次完成／4 次取消；主进程 GC 后 external 从修复前约 652 MiB 降至约 4.3 MiB，新增回归通过 |
| 内存修复后 60 轮 | 40 次完成／20 次取消，遍历同一 60 页 PDF，约 4 分 42 秒；页面堆约 9.1→10.6 MiB，DOM 498→494；退出读物后 Worker／OCR 窗口均为 0，主进程 GC 后 external 仍为 4,518,256 字节；刷新与完整重启恢复通过 |

150 轮中聚合进程 working set 峰值约 2.83 GiB；修复后 12 轮约 2.62 GiB、60 轮约 2.57 GiB。采样间隔 250 ms，进程聚合包含共享页等统计差异，不等同独占物理内存。修复持续保留不等于瞬时占用已经足够低；不能声称数小时稳定性、跨机器性能或低内存体验已验收。

## 原 Morphz 与数据保留

使用原 `/Users/shafreeck/Applications/Morphz.app`、原 profile／center，Runtime 18089 未重启。先确认没有在途工作并对双库在线备份，配置只校验哈希，不打印凭据。实际检查已有 TEST 扫描本的识别、原页对照、校对入口、取消和刷新恢复；末轮内存修复后再次正常重开，并从原窗口取消后重新识别成功。未修改用户书籍。

本次最初重开时出现一次四条引用未显示／本地值为空。已从该 profile 的既有完整记录恢复**同一四条引用原值**，保留 ID、来源、选文及评论，没有重建、重发或创建新消息；完整退出再开和后续导航均仍有四条引用。独立复现并修复了上面的旧地址覆盖窗口缺陷，但该次空值属于同一窗口，**尚不能证明是完全相同的根因**，不把已恢复数据说成已彻底解释这个偶发现象。

数据核对：91 条输入、9 部剧本、44 个内容、9 条标注及其他工作区集合哈希保持；只有阅读状态因 TEST 读物操作而变化。配置／凭据未变，原引用草稿最终仍在。工作区备份和本地草稿恢复证据均留在私有临时目录，不纳入 Git／CI 附件。

## CI 与复现

`.github/workflows/application.yml` 的 macOS Desktop 作业加入草稿重启、真实 OCR 隔离校对、默认 12 轮资源释放测试。下载辅助脚本只接收显式测试目录和 `--download`，从官方地址下载固定大小／SHA-256 的模型；生产下载授权逻辑未改。失败附件只从测试输出收集，不上传 profile、数据库、模型或书籍。

本机已运行这些新增命令；**尚未推送，远端 GitHub CI 未运行**。更长循环可显式设置 `MORPHZ_READER_SOAK_ROUNDS`（4–200）。

```sh
cd application
npm run build
npm test
npm run test:embedded
npm run test:draft-restart
node scripts/reader-ocr-model-fixture.mjs /absolute/test-models --download
npm run test:reader-ocr -- /absolute/test-models /absolute/scan-manifest.json
MORPHZ_READER_SOAK_ROUNDS=60 npm run test:reader-stability -- /absolute/test-models /absolute/public-scan.pdf
npm run test:reader-ocr-quality -- /absolute/test-models /absolute/scan-manifest.json
```

本机主要证据（临时文件不保证长期保留）：

- `/tmp/morphz-reader-complete-{build,unit}.log`、`/tmp/morphz-reader-ui-20260924.log`、`/tmp/morphz-reader-embedded-final-pass.log`。
- `/tmp/morphz-draft-restart-final.log`、`/tmp/morphz-reader-draft-restore-{red,green}.log`。
- `/tmp/morphz-reader-ocr-matrix-fixed-20260924.log`、`/tmp/morphz-reader-ocr-public{3,4}-final.log`、`/tmp/morphz-reader-quality-fixed-20260924.log`。
- `/tmp/morphz-reader-stability-long-final-20260924.log`、`/tmp/morphz-reader-stability-main-gc.log`、`/tmp/morphz-reader-native-buffer-{red,green,unit,60,ocr-final}.log`。
- 结构化循环报告：`test-results/morphz-embedded-electron-*/reader-stability.json`，含 renderer heap／DOM／Worker、主进程 RSS／external、进程 working set、耗时和错误。

后续真实缺口是更广古籍／复杂混排的识别质量、OCR 瞬时内存占用，以及上述偶发引用空值的完整根因；不为掩盖缺口添加提示墙、策略开关或兼容分支。
