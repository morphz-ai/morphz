import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Optional asset authoring, not a website build dependency. Reuses the same
// local sharp installation as render-brand-assets.mjs. No external assets.
const require = createRequire(import.meta.url);
const sharp = require(process.env.MORPHZ_BRAND_SHARP || "sharp");
const assets = new URL("../public/images/articles/", import.meta.url);
const proofs = new URL("../../docs/brand/article-diagrams-20260907/", import.meta.url);
await Promise.all([mkdir(assets, { recursive: true }), mkdir(proofs, { recursive: true })]);
const C = { bg: "#0c1419", panel: "#16252d", border: "#37515c", cyan: "#56d0de", ink: "#eef5f6", muted: "#afc1ca", grey: "#708d9a", amber: "#e4bd82" };
const font = "Arial, 'Hiragino Sans GB', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
let textRuns = [];
function text(x, y, value, size = 28, color = C.ink, weight = 400, maxWidth = 1104, anchor = "start") {
  textRuns.push({ value, size, weight, maxWidth });
  return `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" text-anchor="${anchor}">${escape(value)}</text>`;
}
function box(x, y, w, h, emphasis = false) { return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${emphasis ? "#17333d" : C.panel}" stroke="${emphasis ? "#488997" : C.border}" stroke-width="1.5"/>`; }
function path(points, color = C.cyan, arrow = false) { return `<path d="M${points.map((p) => p.join(" ")).join("L")}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"${arrow ? ' marker-end="url(#arrow)"' : ""}/>`; }
function arrow(points) { return path(points, C.cyan, true); }
function pill(x, y, w, value) { return `<rect x="${x}" y="${y}" width="${w}" height="42" rx="21" fill="#244a56"/>` + text(x + w / 2, y + 29, value, 23, C.cyan, 600, w - 16, "middle"); }
function heading(title, note, h) { return `<rect width="1200" height="${h}" fill="${C.bg}"/>` + text(48, 65, title, 38, C.ink, 600) + text(48, h - 35, note, 25, C.muted); }
function nodeTitle(x, y, value, w = 300) { return text(x + 24, y + 45, value, 27, C.ink, 600, w - 48); }
const words = (locale, zh, en) => locale === "zh" ? zh : en;

function overview(locale) {
  const L = (zh, en) => words(locale, zh, en), h = 800;
  let s = heading(L("结构化上下文求值", "Structured Context Evaluation"), L("模型作判断；运行时验证、提交并执行。", "The model decides; the runtime validates, commits and executes."), h);
  const data = [
    [48, 140, L("结构化上下文", "Structured context"), L("观察 · 认知 · 运行状态", "Observations · Cognition"), L("具有身份与版本", "Runtime state · Identity")],
    [450, 140, L("模型求值", "Model evaluation"), L("理解当前上下文", "Interpret current state"), L("提出事务与下一步动作", "Propose next steps")],
    [852, 140, L("运行时验证", "Runtime validation"), L("检查版本与权限", "Versions · Permissions"), L("守住因果与资源边界", "Causality · Limits")],
    [48, 465, L("新的观察记录", "New observations"), L("工具结果与外部事件", "Tool results and events"), L("进入后续求值", "Input for later evaluation")],
    [450, 465, L("工具与线程执行", "Tools and threads"), L("按权限与依赖推进", "Scope / Dependencies"), L("独立工作可以并行", "Work can run in parallel")],
    [852, 465, L("上下文状态更新", "Context updated"), L("认知更新以事务提交", "Commit cognition"), L("供后续求值读取", "Read on later evaluations")],
  ];
  for (const [x, y, title, a, b] of data) s += box(x, y, 300, 180, x === 48 && y === 140 || x === 852 && y === 465) + nodeTitle(x, y, title) + text(x + 24, y + 99, a, 22, C.muted, 400, 252) + text(x + 24, y + 143, b, 22, C.muted, 400, 252);
  s += arrow([[352, 230], [443, 230]]) + text(398, 211, L("有界视图", "View"), 22, C.cyan, 400, 94, "middle");
  s += arrow([[754, 230], [845, 230]]) + text(800, 211, L("提出变更", "Propose"), 22, C.cyan, 400, 96, "middle");
  s += arrow([[1078, 324], [1078, 458]]) + text(1093, 395, L("提交", "Commit"), 22, C.cyan, 400, 103);
  s += arrow([[949, 324], [949, 381], [600, 381], [600, 458]]) + text(759, 365, L("调度动作", "Schedule actions"), 23, C.cyan, 400, 235, "middle");
  s += arrow([[446, 555], [355, 555]]) + text(400, 536, L("结果", "Results"), 22, C.cyan, 400, 94, "middle");
  s += arrow([[198, 461], [198, 327]]) + text(213, 403, L("进入上下文", "Observe"), 23, C.cyan, 400, 180);
  s += pill(286, 684, 628, L("上下文持续存在，后续求值从新状态继续", "Persistent context. Continue from the updated state."));
  return { body: s, h };
}

function context(locale) {
  const L = (zh, en) => words(locale, zh, en), h = 735;
  let s = heading(L("一次上下文事务", "A context transaction"), L("退出活动上下文的记录仍保留在历史中，需要时可以召回。", "Retired records stay in history and remain available for recall."), h);
  s += box(450, 109, 300, 89, true) + text(600, 143, L("新配置 · @e42", "New config · @e42"), 23, C.muted, 400, 260, "middle") + text(600, 181, L("部署地区：上海", "Region: Shanghai"), 29, C.cyan, 600, 260, "middle");
  s += arrow([[600, 202], [600, 251]]);
  for (const [x, version, region, updated] of [[48, "v17", L("杭州", "Hangzhou"), false], [852, "v18", L("上海", "Shanghai"), true]]) {
    s += box(x, 258, 300, 294, updated) + nodeTitle(x, 258, L(updated ? "更新后" : "当前上下文", updated ? "Updated context" : "Current context"));
    s += text(x + 24, 344, version, 24, C.muted) + text(x + 24, 390, L("部署地区", "Deployment region"), 25, C.muted, 400, 252) + text(x + 24, 446, region, 42, updated ? C.cyan : C.amber, 600, 252);
    s += path([[x + 24, 472], [x + 276, 472]], C.border) + text(x + 24, 513, L("其他认知不变", "Other cognition stays"), 23, C.muted, 400, 252);
  }
  s += box(450, 258, 300, 294, true) + nodeTitle(450, 258, L("智能体提交事务", "Agent submits")) + text(474, 348, "context_tx", 27, C.cyan, 600, 252);
  s += text(474, 403, L("创建新的判断", "Create new judgment"), 23, C.ink, 400, 252) + text(474, 449, L("关联来源与替代关系", "Link sources / revisions"), 23, C.ink, 400, 252) + text(474, 495, L("退役已处理内容", "Retire processed input"), 23, C.ink, 400, 252);
  s += arrow([[352, 416], [443, 416]]) + text(398, 396, L("读取", "Read"), 22, C.cyan, 400, 94, "middle");
  s += arrow([[754, 416], [845, 416]]) + text(800, 396, L("提交", "Commit"), 22, C.cyan, 400, 96, "middle");
  s += box(48, 595, 1104, 68) + text(600, 639, L("运行时验证后整组提交；未通过验证则不提交。", "Runtime validation: commit the whole transaction, or reject it."), 27, C.ink, 500, 1040, "middle");
  return { body: s, h };
}

function concurrency(locale) {
  const L = (zh, en) => words(locale, zh, en), h = 725;
  let s = heading(L("测试在等待，其他线程继续工作", "Work continues while tests run"), L("同一个智能体，通过 schedule_tx 安排线程与依赖。时间仅作示意。", "One agent uses schedule_tx to arrange work and dependencies. Timing is illustrative."), h);
  s += text(48, 129, L("准备一次发布", "Preparing a release"), 27, C.muted) + text(830, 129, L("时间 →", "Time →"), 23, C.muted, 400, 150, "end");
  for (const x of [280, 460, 640, 820]) s += `<path d="M${x} 156V478" stroke="${C.border}" stroke-dasharray="3 8"/>`;
  const rows = [
    [190, L("测试线程", "Tests"), 548, L("启动测试 → 等待工具结果", "Start tests → wait for results"), true],
    [300, L("兼容性线程", "Compatibility"), 443, L("检查平台 → 完成", "Check platforms → done"), false],
    [410, L("文档线程", "Release notes"), 360, L("整理说明 → 完成", "Draft notes → done"), false],
  ];
  for (const [y, name, w, activity, waiting] of rows) {
    s += text(48, y + 44, name, 28, C.ink, 600, 210) + box(280, y, w, 70, !waiting) + text(280 + w / 2, y + 44, activity, 25, waiting ? C.muted : C.cyan, 400, w - 24, "middle");
  }
  s += box(950, 179, 202, 311, true) + text(1051, 227, L("汇合结果", "Join results"), 28, C.ink, 600, 162, "middle") + text(1051, 294, L("等待所需结果", "Wait for all"), 25, C.muted, 400, 162, "middle") + text(1051, 334, L("再检查与决策", "then review"), 25, C.cyan, 500, 162, "middle") + text(1051, 442, L("继续后续工作", "Continue"), 25, C.cyan, 500, 162, "middle");
  s += arrow([[832, 225], [943, 225]]) + arrow([[727, 335], [943, 335]]) + arrow([[644, 445], [943, 445]]);
  s += box(48, 542, 1104, 101, true) + text(76, 583, L("共享认知上下文", "Shared cognitive context"), 30, C.cyan, 600) + text(76, 620, L("线程读取已提交的状态，并通过上下文事务维护它。", "Threads read committed state and maintain it through context transactions."), 25, C.ink, 400, 1048);
  return { body: s, h };
}

function memory(locale) {
  const L = (zh, en) => words(locale, zh, en), h = 825;
  let s = heading(L("历史经验进入新的任务", "Experience carries into new tasks"), L("来源：公开 ME-07 报告 · 每个系统 150 项测试任务，每题尝试一次。", "Source: public ME-07 report · 150 held-out tasks per system, one attempt each."), h);
  const nodes = [[48, L("历史任务", "Past tasks"), L("任务过程与结果", "Observations / outcomes")], [450, L("认知图", "Cognitive graph"), L("认知帧 · 关系 · 来源", "Frames / Links / Sources")], [852, L("新的任务", "New tasks"), L("读取或召回已有经验", "Read / recall experience")]];
  for (const [x, a, b] of nodes) s += box(x, 132, 300, 137, x === 450) + nodeTitle(x, 132, a) + text(x + 24, 231, b, 23, C.muted, 400, 252);
  s += arrow([[352, 200], [443, 200]]) + text(398, 182, L("事务", "context_tx"), 19, C.cyan, 400, 95, "middle");
  s += arrow([[754, 200], [845, 200]]) + text(800, 182, L("复用", "Reuse"), 23, C.cyan, 400, 96, "middle");
  s += box(48, 322, 1104, 410);
  s += text(76, 366, "ME-07 · STATE-Bench", 26, C.muted, 500);
  s += text(76, 465, "81.33%", 75, C.cyan, 700, 430) + text(76, 510, L("Morphz 任务完成率", "Morphz task completion"), 28, C.ink, 500, 400) + text(76, 552, "122 / 150", 27, C.muted, 400, 400);
  const bars = [["Morphz", 81.33, C.cyan], ["Letta", 62, C.grey], [L("Mem0 参考智能体", "Mem0-backed reference"), 64, C.grey]];
  for (const [i, [name, value, color]] of bars.entries()) {
    const y = 378 + i * 94;
    s += text(600, y, name, 25, i ? C.muted : C.cyan, i ? 400 : 600, 360) + `<rect x="600" y="${y + 17}" width="350" height="18" rx="4" fill="#293d46"/><rect x="600" y="${y + 17}" width="${350 * value / 100}" height="18" rx="4" fill="${color}"/>` + text(995, y + 29, value.toFixed(2) + "%", 29, i ? C.ink : C.cyan, 600, 135);
  }
  for (const [x, value, anchor] of [[600, "0", "start"], [775, "50", "middle"], [950, "100%", "end"]]) s += text(x, 649, value, 21, C.muted, 400, 65, anchor);
  s += text(76, 700, L("相同历史任务 · 相同 GPT-5.6 Sol 模型", "Same historical tasks · Same GPT-5.6 Sol model"), 25, C.muted);
  return { body: s, h };
}

const draws = { "structured-context-evaluation": overview, "context-transactions": context, "concurrent-threads": concurrency, "cross-task-memory": memory };
const descriptions = {
  zh: {
    "structured-context-evaluation": "模型对结构化上下文的有界视图求值，提出事务与动作；运行时验证后提交认知变更并调度执行。工具结果成为新的观察，后续求值从更新后的状态继续。",
    "context-transactions": "配置检查确认部署地区为上海。智能体提交上下文事务，创建新判断、关联来源并退役已处理内容。上下文从 v17 更新到 v18，其他认知不变，历史记录仍可召回。",
    "concurrent-threads": "同一个智能体并发推进测试、兼容性检查与发布说明。测试等待工具时，其他线程继续工作；所需结果汇合后再检查并继续。线程共享已提交的认知状态。",
    "cross-task-memory": "智能体通过上下文事务把历史经验组织为认知帧与关系，用于新任务。ME-07 任务完成率：Morphz 81.33%，Letta 62.00%，Mem0 参考智能体 64.00%。每个系统测试 150 项任务，每题尝试一次。",
  },
  en: {
    "structured-context-evaluation": "The model evaluates a bounded view of structured context and proposes transactions and actions. The runtime validates cognitive commits and execution requests. Tool results become new observations; later evaluations read the updated state.",
    "context-transactions": "A configuration check changes the deployment region from Hangzhou to Shanghai. The agent submits a context transaction to create the new judgment, link its sources and retire processed material. Other cognition is unchanged; historical records remain retrievable.",
    "concurrent-threads": "One agent runs test, compatibility and release-note threads concurrently. Waiting for test results does not stop the other threads. Required results join before review; all threads share committed cognitive state.",
    "cross-task-memory": "The agent maintains past experience through context transactions in a cognitive graph, then reads or recalls it for new tasks. ME-07 task completion: Morphz 81.33%, Letta 62.00%, Mem0-backed reference agent 64.00%. Each system attempted 150 held-out tasks once.",
  },
};
const checks = [];
const overflows = [];
const rendered = [];
for (const locale of ["zh", "en"]) {
  for (const [name, draw] of Object.entries(draws)) {
    textRuns = [];
    const { body, h } = draw(locale);
    for (const run of textRuns) {
      const sample = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="150"><text x="10" y="110" font-family="${font}" font-size="${run.size}" font-weight="${run.weight}" fill="white">${escape(run.value)}</text></svg>`;
      const { info } = await sharp(Buffer.from(sample)).trim({ background: "#00000000", threshold: 1 }).png().toBuffer({ resolveWithObject: true });
      if (info.width > run.maxWidth + 2) overflows.push(`${name}/${locale}: ${run.value} (${info.width} > ${run.maxWidth})`);
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="${h}" viewBox="0 0 1200 ${h}" role="img" aria-labelledby="title desc" lang="${locale === "zh" ? "zh-CN" : "en"}"><title id="title">${escape(name)}</title><desc id="desc">${escape(descriptions[locale][name])}</desc><defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto"><path d="M1 1L7 4.5L1 8" fill="none" stroke="${C.cyan}" stroke-width="1.5"/></marker></defs><g font-family="${font}">${body}</g></svg>`;
    const filename = `${name}-${locale}-v1.svg`;
    rendered.push({ filename, svg });
    checks.push({ filename, width: 1200, height: h, bytes: Buffer.byteLength(svg), textFit: "pass", alt: descriptions[locale][name] });
  }
}
if (overflows.length) throw new Error(`Text overflows:\n${overflows.join("\n")}`);
for (const { filename, svg } of rendered) {
  await writeFile(new URL(filename, assets), svg);
  await sharp(Buffer.from(svg)).png().toFile(fileURLToPath(new URL(filename.replace(".svg", ".png"), proofs)));
  console.log(`Rendered ${filename}`);
}
await writeFile(new URL("asset-checks.json", proofs), JSON.stringify(checks, null, 2) + "\n");
