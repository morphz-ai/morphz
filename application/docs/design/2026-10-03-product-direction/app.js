/* Visual proposal only. No network, storage, Runtime or Platform calls. */
const icons = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  chat: '<path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/><path d="M8 9h9M8 13h6"/>',
  "chat-lines":
    '<path d="M5 4h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z"/><path d="M8 8h9M8 11h9M8 14h5"/>',
  "circle-check": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  circle: '<circle cx="12" cy="12" r="8.5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  files:
    '<path d="M8 4h8l4 4v12H8Z"/><path d="M16 4v4h4M4 5v15h11M11 12h6M11 16h5"/>',
  document:
    '<path d="M6 3h9l4 4v14H6Z"/><path d="M15 3v4h4M9 11h7M9 15h7M9 18h4"/>',
  grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 12h16M12 4v16"/>',
  "square-pen":
    '<path d="M10 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-5M13 4l3-3 5 5-3 3M7 15l11-11 3 3-11 11-4 1Z"/>',
  "chevron-down": '<path d="m6 9 6 6 6-6"/>',
  "chevron-right": '<path d="m9 6 6 6-6 6"/>',
  panel:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  book: '<path d="M12 5v15M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Z"/>',
  film: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 3v18M16 3v18M4 8h4M4 16h4M16 8h4M16 16h4M8 12h8"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z"/>',
  table:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M3 14h18M9 9v11M15 9v11"/>',
  expand: '<path d="M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7"/>',
  pin: '<path d="m8 3 8 0-1 6 4 5H5l4-5ZM12 14v7"/>',
  link: '<path d="M9 7H7a5 5 0 0 0 0 10h2M15 7h2a5 5 0 0 1 0 10h-2M8 12h8"/>',
  x: '<path d="m6 6 12 12M6 18 18 6"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  mic: '<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M6 10v3a6 6 0 0 0 12 0v-3M12 19v3M8 22h8"/>',
  "arrow-up": '<path d="M12 20V4M6 10l6-6 6 6"/>',
  "arrow-up-right": '<path d="M6 18 18 6M6 6h12v12"/>',
  more: '<circle cx="5" cy="12" r=".6"/><circle cx="12" cy="12" r=".6"/><circle cx="19" cy="12" r=".6"/>',
  activity:
    '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="7" cy="5" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="10" cy="19" r="1.5"/>',
  shield:
    '<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6Z"/><path d="m8 11 3 3 5-6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 6v7h5"/>',
  sliders:
    '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>',
  branches:
    '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="9" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v9c0 2 1 3 3 3h7M6 9h10"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.document}</svg>`;
const brandMark =
  '<svg class="agent-mark" viewBox="0 0 96 96" aria-hidden="true"><path d="M8 4 48 40 38 40 38 70 8 92Z M88 4 48 40 58 40 58 70 88 92Z"/></svg>';
const state = {
  page: "dialogue",
  scope: "个人空间",
  execution: "running",
  tab: "activity",
  reading: false,
  input: true,
  pinned: false,
  inspector: true,
  detail: false,
  filter: "all",
  view: "list",
  profile: true,
  effort: "最高",
};
const $ = (selector) => document.querySelector(selector);
const hydrateIcons = () =>
  document.querySelectorAll("[data-icon]").forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
const runGlyph = (status = state.execution) =>
  status === "running"
    ? '<span class="run-glyph" aria-label="执行中"><i></i></span>'
    : `<span class="run-glyph ${status}" aria-label="${status === "done" ? "执行结束" : "需要处理"}">${icon(status === "done" ? "circle-check" : "alert")}</span>`;
function notify(message) {
  $("#toast").replaceChildren(document.createTextNode(message));
  const close = document.createElement("button");
  close.textContent = "关闭";
  close.addEventListener("click", () => ($("#toast").hidden = true));
  $("#toast").append(close);
  $("#toast").hidden = false;
}
function openDialog(title, content) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = content;
  hydrateIcons();
  $("#preview-dialog").showModal();
}
function dialogueMarkup() {
  if (state.scope.startsWith("产品实验室"))
    return `<div class="conversation-feed"><div class="date-label">产品实验室 · 示例交流</div><div class="message-user"><p>让工作自然接续，应该怎么组织界面？</p></div><div class="message-meta">15:40</div><article class="agent-message"><div class="agent-byline">${brandMark}<span>Morphz</span></div><p>把工作画布作为稳定的现场，输入与交流围绕它展开。应用切换改变工作工具，不需要把当前想法重新说一遍。</p><button class="delivery" data-app="document"><span class="delivery-icon">${icon("document")}</span><span><strong>让工作自然接续</strong><small>文档 · 产品实验室 · 示例内容</small></span><span>${icon("arrow-up-right")}</span></button></article></div>`;
  return `<div class="conversation-feed"><div class="date-label">今天 · 10 月 3 日</div>
    <div class="message-user"><p>《领证前夜》的两位主角设定和五场大纲，继续完善一下。<br>保留轻喜剧，但冲突不要靠误会。</p></div><div class="message-meta">16:08 ${icon("copy")}</div>
    <article class="agent-message"><div class="agent-byline">${brandMark}<span>Morphz</span><span class="byline-state">接续已有内容</span></div>
      <p>好。这次不重写已经确认的方向，而是把两位主角的选择动机，与五场戏的情绪推进对齐。</p>
      <h2>把冲突，放在真正的分歧上</h2>
      <p>他们都想结婚，只是对「承诺」的理解不同：一个相信提前做好计划，另一个更在意当下是否被理解。喜剧来自两种做事方式的碰撞，而不是靠隐瞒制造误会。</p>
      <ul><li><strong>人物：</strong>让各自的坚持有来处，也有可以松动的地方。</li><li><strong>节奏：</strong>从小小的不合拍，走向一次坦诚的选择。</li></ul>
      <button class="delivery" data-app="script"><span class="delivery-icon">${icon("film")}</span><span><strong>领证前夜 · 人物与五场大纲</strong><small>剧本工作室 · 示例内容版本 v3</small></span><span>${icon("arrow-up-right")}</span></button>
      <p>人物设定与场次大纲会放在同一份内容里，后面可以逐场继续打磨。</p>
      <div class="ongoing-inline">${runGlyph()}<span><strong>${state.execution === "running" ? "正在对齐人物动机与场次" : state.execution === "done" ? "本次执行结束" : "等待处理版本差异"}</strong> · ${state.execution === "running" ? "查看右侧活动" : state.execution === "done" ? "结果待你确认" : "已有内容保留"}</span></div>
    </article><div class="message-meta" style="justify-content:flex-start;margin-top:16px">16:09 ${icon("copy")}</div>
    <div class="message-user"><div class="message-ref" tabindex="0"><span class="ref-source">引用 Morphz 的回复</span><span class="ref-excerpt">喜剧来自两种做事方式的碰撞，而不是靠隐瞒制造误会。让各自的坚持有来处，也有可以松动的地方。</span></div><p>对，重点是让观众同时理解两个人。</p></div><div class="message-meta">16:10 · 补充已送达</div>
  </div>`;
}
function workbenchMarkup(library = false) {
  return `<div class="canvas-content"><div class="section-header"><h2>${library ? "工作内容" : "继续工作"}</h2>${library ? "" : `<button class="text-button" data-page="library">全部内容 ${icon("chevron-right")}</button>`}</div>
    <div class="recent-grid"><button class="recent-card" data-app="script"><div class="card-preview"><div><h3>领证前夜</h3><p>人物动机与五场节奏。<br>保留轻喜剧，不靠误会推进。</p></div><span class="cover-line"></span></div><div class="card-footer">${icon("film")}<span>剧本 · v3</span><time>刚刚打开</time></div></button>
    <button class="recent-card" data-app="document"><div class="card-preview analysis"><div><h3>让工作自然接续</h3><p>对话表达意图，内容承载结果。<br>关于持续协作的设计笔记。</p></div><span class="cover-line"></span></div><div class="card-footer">${icon("document")}<span>文档 · 产品实验室</span><time>25 分钟前</time></div></button></div>
    ${
      library
        ? `<div class="section-header"><h2>最近内容</h2><span class="section-eyebrow">按最近打开排序</span></div><table class="task-table"><thead><tr><th>名称</th><th>类型</th><th>项目</th></tr></thead><tbody><tr><td><button class="task-title" data-app="script">${icon("film")}<strong>领证前夜 · 人物与五场大纲</strong></button></td><td>剧本</td><td>领证前夜</td></tr><tr><td><button class="task-title" data-app="document">${icon("document")}<strong>让工作自然接续</strong></button></td><td>文档</td><td>产品实验室</td></tr></tbody></table>`
        : `<div class="section-header"><h2>应用</h2><button class="text-button" data-action="manage">管理应用</button></div><div class="application-grid">
    <button class="application-tile" data-app="document"><span class="application-icon">${icon("book")}</span><span><strong>文档</strong><small>写作、阅读与接续思考</small></span><span>${icon("chevron-right")}</span></button>
    <button class="application-tile" data-app="script"><span class="application-icon violet">${icon("film")}</span><span><strong>剧本工作室</strong><small>人物、场次与故事节奏</small></span><span>${icon("chevron-right")}</span></button>
    <button class="application-tile" data-app="browser"><span class="application-icon cyan">${icon("globe")}</span><span><strong>浏览器</strong><small>在原始页面上继续工作</small></span><span>${icon("chevron-right")}</span></button>
    <button class="application-tile" data-app="table"><span class="application-icon green">${icon("table")}</span><span><strong>表格</strong><small>记录、整理与观察数据</small></span><span>${icon("chevron-right")}</span></button></div>
    `
    }</div>`;
}
const sampleTasks = [
  {
    id: "script",
    title: "完善《领证前夜》人物与五场大纲",
    note: "已有方向继续打磨",
    owner: "Morphz",
    date: "今天",
    group: "今天",
    status: "working",
  },
  {
    id: "motivation",
    title: "确认人物的选择动机",
    note: "阅读 v3 后给出反馈",
    owner: "我",
    date: "今天",
    group: "今天",
    status: "pending",
  },
  {
    id: "context",
    title: "整理剧本内部阶段的上下文传递",
    note: "产品实验室",
    owner: "Morphz",
    date: "10 月 5 日",
    group: "本周",
    status: "pending",
  },
  {
    id: "summary",
    title: "核对活动标题与最终摘要",
    note: "仅记录，尚未安排执行",
    owner: "我",
    date: "10 月 6 日",
    group: "本周",
    status: "pending",
  },
  {
    id: "boundary",
    title: "记录活动注解的边界",
    note: "结果与原始输入保持关联",
    owner: "Morphz",
    date: "已完成",
    group: "已完成",
    status: "done",
  },
];
function taskMarkup() {
  let list = sampleTasks.filter(
    (t) =>
      state.filter === "all" ||
      (state.filter === "mine" ? t.owner === "我" : t.owner === "Morphz"),
  );
  let content = "";
  if (state.view === "board") {
    content = `<div class="task-board">${[
      ["pending", "待处理"],
      ["working", "进行中"],
      ["review", "待确认"],
      ["done", "已完成"],
    ]
      .map(
        ([status, label]) =>
          `<section class="board-column"><h2>${label}</h2>${list
            .filter(
              (t) =>
                (t.status === "working" && state.execution === "done"
                  ? "review"
                  : t.status) === status,
            )
            .map(
              (t) =>
                `<button class="board-card" data-task="${t.id}">${t.title}<small>${t.owner} · ${t.date}</small></button>`,
            )
            .join("")}</section>`,
      )
      .join("")}</div>`;
  } else {
    content = ["今天", "本周", "已完成"]
      .map((group) => {
        const rows = list.filter((t) => t.group === group);
        return rows.length
          ? `<div class="task-group-title">${group}<span>${rows.length}</span></div><table class="task-table"><thead><tr><th>事项</th><th>负责</th><th>日期</th></tr></thead><tbody>${rows.map((t) => `<tr><td><button class="task-title" data-task="${t.id}">${t.status === "done" ? icon("circle-check") : t.status === "working" && state.execution === "running" ? runGlyph() : icon("circle")}<span><strong>${t.title}</strong><small>${t.status === "working" && state.execution === "done" ? "执行结束 · 事项待确认" : t.note}</small></span></button></td><td>${t.owner}</td><td>${t.date}</td></tr>`).join("")}</tbody></table>`
          : "";
      })
      .join("");
  }
  return `<div class="canvas-content"><div class="filter-bar" role="group" aria-label="事项范围"><button data-filter="all" aria-pressed="${state.filter === "all"}">全部 <span>5</span></button><button data-filter="mine" aria-pressed="${state.filter === "mine"}">我的事项 <span>2</span></button><button data-filter="agent" aria-pressed="${state.filter === "agent"}">Morphz <span>3</span></button></div>${content}</div>`;
}
function documentMarkup(script) {
  return `<article class="document-surface"><div class="doc-label">${script ? "SCREENPLAY / 03" : "PRODUCT NOTES / 07"} · 示例内容</div><h1>${script ? "领证前夜" : "让工作自然接续"}</h1><div class="doc-subtitle">${script ? "人物设定与五场大纲 · v3" : "关于持续工作与活动表达的笔记"}</div>${script ? `<p>两个准备领证的人，在最后一夜发现：关于未来，他们从未真正谈过同一件事。</p><h2>人物</h2><p><strong>林知夏</strong> · 相信把事情安排好，才算认真。她的计划不是为了控制对方，而是对不确定性的回应。</p><p><strong>周予安</strong> · 更在意当下是否被理解。他不回避承诺，只是害怕承诺变成另一张考核表。</p><h2>五场节奏</h2>${["一个不合拍的准备之夜", "一次越解释越偏的讨论", "各自试着替对方作决定", "承认自己真正担心的事", "带着不完美一起出门"].map((title, i) => `<section class="scene-row"><span>0${i + 1}</span><div><strong>${title}</strong><p>${["生活细节里，藏着两种不同的安全感。", "笑点来自立场，而非信息缺失。", "好意也有边界，观众能够同时理解双方。", "坦诚不是解决所有问题，而是愿意一起面对。", "承诺落在一次具体、共同的选择上。"][i]}</p></div></section>`).join("")}` : `<p>对话是表达意图的入口，内容是工作真正留下的东西。切换工作现场，不应意味着重新解释背景。</p><h2>让工作有自己的形状</h2><p>一份文档、一条事项、一段剧本，各自有适合阅读和继续操作的界面。共享的输入保持稳定，应用负责呈现具体工作。</p><h2>把执行的变化说清楚</h2><p>活动展示当前正在做什么、已经做成什么，以及需要人处理什么。过程可以并行，结果需要有可追溯的来源。</p><p>完成不是光点停止旋转，而是一个可阅读、可继续使用的结果。</p>`}</article>`;
}
function renderPage() {
  const titles = {
    dialogue: "对话",
    workbench: "工作台",
    tasks: "事项",
    library: "内容库",
    script: "剧本工作室",
    document: "文档",
    browser: "浏览器",
    table: "表格",
  };
  $("#page-title").textContent = titles[state.page] || "对话";
  $("#page-scope").textContent = state.scope;
  $("#main-surface").classList.toggle("work-mode", state.page !== "dialogue");
  $("#page-actions").innerHTML =
    state.page === "tasks"
      ? `<div class="task-view-toggle" role="group" aria-label="事项视图"><button data-view="list" aria-pressed="${state.view === "list"}">列表</button><button data-view="board" aria-pressed="${state.view === "board"}">看板</button></div>`
      : state.page === "workbench"
        ? ""
        : ["script", "document"].includes(state.page)
          ? '<button class="text-button" data-action="versions">版本</button><button class="text-button" data-action="edit">手动编辑</button>'
          : state.page === "dialogue"
            ? '<button class="text-button" data-action="scope-info">个人持续对话</button>'
            : "";
  $("#canvas").innerHTML =
    state.page === "dialogue"
      ? dialogueMarkup()
      : state.page === "workbench"
        ? workbenchMarkup()
        : state.page === "library"
          ? workbenchMarkup(true)
          : state.page === "tasks"
            ? taskMarkup()
            : ["script", "document"].includes(state.page)
              ? documentMarkup(state.page === "script")
              : state.page === "table"
                ? '<div class="canvas-content"><div class="section-header"><h2>场次节奏 · 示例记录</h2></div><table class="task-table"><thead><tr><th>场次</th><th>阶段</th><th>节奏</th></tr></thead><tbody><tr><td>不合拍的准备之夜</td><td>开场</td><td>轻快</td></tr><tr><td>一次越解释越偏的讨论</td><td>推进</td><td>紧凑</td></tr><tr><td>承认自己真正担心的事</td><td>转折</td><td>沉静</td></tr></tbody></table></div>'
                : '<div class="canvas-content"><div class="empty-preview">浏览器画布<p>保留独立的网页工作现场。此视觉稿不加载外部网站。</p><button class="text-button" data-page="workbench">返回工作台</button></div></div>';
  document
    .querySelectorAll(".primary-nav [data-page]")
    .forEach((button) =>
      button.setAttribute(
        "aria-current",
        button.dataset.page === state.page ? "page" : "false",
      ),
    );
  $("#history-button").hidden = state.page === "dialogue";
  $("#composer-context").hidden = !["script", "document", "table"].includes(
    state.page,
  );
  $("#composer-context > span:nth-child(2)").textContent =
    state.page === "script"
      ? "领证前夜 · 人物与五场大纲"
      : state.page === "document"
        ? "产品实验室 · 让工作自然接续"
        : "领证前夜 · 场次节奏";
  $("#intent-input").placeholder =
    state.page === "script" ? "继续打磨这段故事…" : "提出想法，或让工作继续…";
  if (state.page === "dialogue") {
    state.reading = false;
    state.input = true;
  }
  syncExchange();
  hydrateIcons();
}
function activityMarkup() {
  const statusText =
    state.execution === "running"
      ? "执行中"
      : state.execution === "done"
        ? "执行结束"
        : "需要处理";
  return `<div class="section-label">${state.execution === "running" ? "进行中" : "本次工作"}<span>01</span></div><section class="active-activity"><div class="activity-topline">${runGlyph()}<span>${statusText}</span><span class="activity-time">16:09</span></div><button class="activity-title" data-action="activity-detail" aria-expanded="${state.detail}">完善人物与五场大纲</button><p class="activity-summary">${state.execution === "running" ? "接续已有版本，让两个人的选择与五场节奏彼此照应。" : state.execution === "done" ? "人物与场次已对齐，保留原有方向。结果仍待你阅读确认。" : "发现内容版本差异，等待你选择以哪一版继续。已有内容未覆盖。"}</p><div class="execution-nodes" aria-hidden="true"><b class="complete"></b><b class="complete"></b><b class="${state.execution === "done" ? "complete" : state.execution === "running" ? "active" : ""}"></b><b class="${state.execution === "done" ? "complete" : ""}"></b></div><div class="execution-caption"><span>${state.execution === "running" ? "对齐场次节奏" : state.execution === "done" ? "结果待确认" : "等待版本确认"}</span><span>${state.execution === "done" ? "4 / 4" : "2 / 4"} 步骤结束</span></div><div class="activity-tree"><div class="thread-heading">${icon("branches")}主线程 · 协调工作</div><div class="thread-branch"><div class="thread-line">${icon("circle-check")}人物设定<small>已结束</small></div><div class="thread-line">${runGlyph()}五场大纲<small>${statusText}</small></div></div></div>${state.detail ? '<p class="thread-detail"><strong>人物设定</strong><br>读取已有版本 → 核对人物动机 → 返回调整建议。<br><br><strong>五场大纲</strong><br>接收补充要求 → 调整场次 → 交叉核对人物选择。<br><br>两个子 Thread 归入同一主活动。此处为分组表达示例。</p>' : ""}</section><div class="section-label">今天<span>02</span></div><button class="history-activity" data-action="past-activity"><span>${icon("circle-check")}</span><span><strong>记录上下文传递问题</strong><p>整理已确认范围与阶段输入的差异，留下后续检查线索。</p><time>15:42</time></span></button><button class="history-activity" data-action="past-activity"><span>${icon("circle-check")}</span><span><strong>读取新批次记录</strong><p>核对编号、数量与数据格式。</p><time>14:56</time></span></button>`;
}
function renderInspector() {
  $("#subject-state").textContent =
    state.execution === "running"
      ? "正在推进 1 项工作"
      : state.execution === "done"
        ? "本次执行已结束"
        : "有 1 项工作需要处理";
  const content =
    state.tab === "activity"
      ? activityMarkup()
      : state.tab === "authority"
        ? '<div class="section-label">授权范围</div><div class="permission-row"><strong>当前项目内容</strong><small>领证前夜 · 示例已授权范围</small></div><div class="permission-row"><strong>工作目录</strong><small>未选择目录</small></div><p class="inspector-copy">权限在这里核对。任何新授权都需要由你明确确认。</p>'
        : state.tab === "schedule"
          ? `<div class="section-label">之后的安排</div><div class="permission-row"><strong>明天提醒我参加活动</strong><small>明天 09:00 · 固定消息提醒示例</small></div><p class="inspector-copy">安排与当前执行分开呈现，不用运行中的动画表示未来事件。</p>`
          : `<div class="section-label">身份与表达</div><div class="profile-name">Morphz<button data-action="profile-switch" aria-label="${state.profile ? "停用" : "启用"} Profile（仅演示）" aria-pressed="${state.profile}" class="profile-switch ${state.profile ? "" : "off"}"><i></i></button></div><div style="opacity:${state.profile ? 1 : 0.5}"><div class="profile-row"><span>幽默</span><small>克制</small></div><div class="profile-row"><span>严谨</span><small>说明要点</small></div><div class="profile-row"><span>亲和</span><small>自然</small></div><div class="profile-row"><span>详略</span><small>重点清楚</small></div><div class="profile-row"><span>讲话风格</span><small>自然</small></div></div><p class="inspector-copy">${state.profile ? "示例偏好。此原型不修改真实 Profile。" : "已停用的视觉示例。偏好保留，但当前不生效。"}</p>`;
  $("#inspector-body").innerHTML = content;
  $("#inspector-body").setAttribute("aria-labelledby", `tab-${state.tab}`);
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === state.tab;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  hydrateIcons();
}
function syncExchange() {
  $("#reading-panel").hidden = !state.reading;
  $("#workspace").classList.toggle("has-reading", state.reading);
  $("#history-button").setAttribute("aria-pressed", String(state.reading));
  $("#history-button").setAttribute(
    "aria-label",
    state.reading ? "收起当前交流" : "展开当前交流",
  );
  $("#exchange-region").hidden = !state.input;
  $("#reopen-input").hidden = state.input;
  $("#pin-button").setAttribute("aria-pressed", String(state.pinned));
}
function navigate(page, scope = state.scope) {
  state.page = page;
  state.scope = scope;
  renderPage();
  $("#canvas").scrollTop = 0;
}
function handleAction(action) {
  if (action === "history") {
    state.reading = !state.reading;
    syncExchange();
  } else if (action === "full-history") navigate("dialogue");
  else if (action === "hide-input") {
    if (state.page === "dialogue") {
      notify("专用对话页保持消息与输入常驻。工作页可收起输入。");
      return;
    }
    state.input = false;
    state.reading = false;
    syncExchange();
  } else if (action === "show-input") {
    state.input = true;
    syncExchange();
    $("#intent-input").focus();
  } else if (action === "pin") {
    state.pinned = !state.pinned;
    syncExchange();
    notify(
      state.pinned
        ? "演示：输入已固定。切换页面仍保留草稿。"
        : "演示：已取消固定。",
    );
  } else if (action === "inspector") {
    state.inspector = !state.inspector;
    $("#workspace").classList.toggle("inspector-hidden", !state.inspector);
    $(".inspector-toggle").setAttribute(
      "aria-expanded",
      String(state.inspector),
    );
    $(".inspector-toggle").setAttribute(
      "aria-label",
      state.inspector ? "隐藏 Morphz 信息" : "显示 Morphz 信息",
    );
  } else if (action === "activity-detail") {
    state.detail = !state.detail;
    renderInspector();
  } else if (action === "project" || action === "product-project") {
    navigate("dialogue", action === "project" ? "领证前夜" : "产品实验室");
  } else if (action === "draft" || action === "draft-product") {
    navigate(
      "dialogue",
      action === "draft" ? "领证前夜 · 新对话草稿" : "产品实验室 · 新对话草稿",
    );
    $("#intent-input").focus();
    notify("仅展示本地草稿入口，未创建 Session，也未提交消息。");
  } else if (action === "clear-context") $("#composer-context").hidden = true;
  else if (action === "close-dialog") $("#preview-dialog").close();
  else if (action === "search")
    openDialog(
      "搜索工作内容",
      '<input class="search-input" aria-label="搜索示例内容" placeholder="输入关键词…" id="sample-search"><div id="search-results"><button class="search-result" data-app="script">领证前夜 · 人物与五场大纲</button><button class="search-result" data-app="document">让工作自然接续</button><button class="search-result" data-page="tasks">我的事项</button></div>',
    );
  else if (action === "projects")
    openDialog(
      "项目目录",
      '<button class="search-result" data-action="project">领证前夜</button><button class="search-result" data-action="product-project">产品实验室</button>',
    );
  else if (action === "model")
    openDialog(
      "模型与请求设定",
      `<p>此处只演示选择的视觉反馈。</p><div class="dialog-model" role="group" aria-label="思考强度">${["默认", "轻量", "较高", "最高"].map((e) => `<button data-effort="${e}" aria-pressed="${e === state.effort}">${e}</button>`).join("")}</div>`,
    );
  else if (action === "profile-switch") {
    state.profile = !state.profile;
    renderInspector();
  } else if (action === "manage" || action === "browse")
    openDialog(
      action === "manage" ? "应用管理" : "浏览应用",
      "<p>工作台是应用浏览、设定与管理的统一入口。Dock 只负责快捷打开。</p><p>此提案只呈现入口与信息层级，不模拟安装、权限授予或市场服务。</p>",
    );
  else if (action === "past-activity")
    openDialog(
      "活动结果示例",
      "<p>记录上下文传递问题。</p><p>读取原始输入 → 核对已确认范围 → 记录差异。</p><p>成功的命令步骤与整个执行的结果分别呈现，不将工具返回直接当作事项完成。</p>",
    );
  else if (action === "send")
    notify("这是视觉原型，未发送消息、未调用模型。输入文字仍保留。");
  else if (action === "scope-info")
    openDialog(
      "个人持续对话",
      "<p>对话、事项、内容库与工作台属于同一个个人持续交流空间。项目内的命名会话仍独立。</p>",
    );
  else if (action === "versions")
    openDialog(
      "内容版本",
      "<p>v3 · 当前视觉示例<br>v2 · 人物动机调整<br>v1 · 初始五场大纲</p>",
    );
  else if (action === "edit")
    notify("原型只展示手动编辑入口，没有修改真实内容。");
  else if (action === "attachments")
    openDialog(
      "附件与工作目录",
      "<p>附件用于提交要处理的内容。工作目录授权是独立、明确的读写权限。</p><p>此演示不选择文件、不扫描目录，也不授予权限。</p>",
    );
  else if (action === "voice") notify("仅演示语音入口，不启动麦克风。");
  else if (action === "account")
    openDialog(
      "个人空间",
      "<p>本人身份与客户端设定在这里。Morphz 的主体设定留在右侧，两者不混在一起。</p>",
    );
  else if (action === "subject-menu")
    openDialog(
      "Morphz 主体信息",
      "<p>活动、授权、安排与设定围绕同一主体组织。此原型不切换 Agent、不更改真实参数。</p>",
    );
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.direction) {
    document.documentElement.dataset.direction = button.dataset.direction;
    document
      .querySelectorAll(".direction-picker button")
      .forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  } else if (button.dataset.page) {
    if ($("#preview-dialog").open) $("#preview-dialog").close();
    navigate(button.dataset.page, "个人空间");
  } else if (button.dataset.app) {
    if ($("#preview-dialog").open) $("#preview-dialog").close();
    const owners = {
      script: "领证前夜",
      document: "产品实验室",
      browser: "个人空间",
      table: "领证前夜",
    };
    navigate(button.dataset.app, owners[button.dataset.app] || "个人空间");
  } else if (button.dataset.task) {
    const task = sampleTasks.find((t) => t.id === button.dataset.task);
    openDialog(
      task.title,
      task.id === "script"
        ? "<p><strong>已确认范围</strong><br>保留轻喜剧方向，继续完善两位主角与五场节奏。</p><p><strong>当前补充</strong><br>冲突不要靠误会，让观众同时理解两个人。</p><p><strong>验收</strong><br>人物动机自洽，场次与选择相互照应。执行结束后，事项仍需按其完成条件确认。</p>"
        : `<p>${task.note}</p><p>负责：${task.owner}<br>日期：${task.date}<br>状态：${task.status === "done" ? "已完成" : "待处理"}</p><p>这是对应事项的视觉示例，未发起执行或更改完成状态。</p>`,
    );
  } else if (button.dataset.tab) {
    state.tab = button.dataset.tab;
    renderInspector();
  } else if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    renderPage();
  } else if (button.dataset.view) {
    state.view = button.dataset.view;
    renderPage();
  } else if (button.dataset.effort) {
    state.effort = button.dataset.effort;
    $(".model-control").innerHTML =
      `gpt-6.1-sol <span class="setting-divider">/</span> ${state.effort} ${icon("chevron-down")}`;
    $("#preview-dialog").close();
  } else if (button.dataset.action) {
    if (
      ["project", "product-project"].includes(button.dataset.action) &&
      $("#preview-dialog").open
    )
      $("#preview-dialog").close();
    handleAction(button.dataset.action);
  }
});
$("#state-picker").addEventListener("change", (event) => {
  state.execution = event.target.value;
  renderInspector();
  renderPage();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    $("#toast").hidden = true;
    if (state.reading) {
      state.reading = false;
      syncExchange();
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if (!$("#preview-dialog").open) handleAction("search");
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    handleAction("show-input");
  }
  if (
    event.target.matches('[role="tab"]') &&
    ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
  ) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    const current = tabs.indexOf(event.target);
    const index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (current + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) %
            tabs.length;
    tabs[index].focus();
    state.tab = tabs[index].dataset.tab;
    renderInspector();
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "sample-search") {
    const query = event.target.value.toLowerCase();
    document
      .querySelectorAll(".search-result")
      .forEach(
        (el) => (el.hidden = !el.textContent.toLowerCase().includes(query)),
      );
  }
});
$(".brand").addEventListener("click", (event) => {
  event.preventDefault();
  navigate("dialogue", "个人空间");
});
renderPage();
renderInspector();
if (window.matchMedia("(max-width:750px)").matches) handleAction("inspector");
