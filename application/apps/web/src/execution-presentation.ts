import { isObjectToolName } from "../../../packages/core/src/application-names.js";
import {
  jobStatusLabel,
  type ExecutionSnapshot,
} from "../../../packages/core/src/execution.js";
import type { LiveMessage } from "../../../packages/core/src/live-conversation.js";
import type { Workspace } from "../../../packages/core/src/model.js";
import {
  currentScriptDraft,
  scriptKindLabels,
} from "../../../packages/core/src/script-studio.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const short = (value: string) => value.replace(/\s+/g, " ").slice(0, 160);

/** Discovery is only a transport wrapper. Project known operations onto the
 * existing display paths; never execute, validate or infer authority here. */
function operationRequest(id: string, parameters: Record<string, unknown>) {
  const actions: Record<string, string> = {
    "input.read": "read-input",
    "connection.status": "connection-status",
    "conversations.search": "conversation-search",
    "content.list": "list",
    "content.search": "search",
    "content.read": "read",
    "content.create-document": "create-document",
    "content.revise-document": "revise-document",
    "content.organize": "organize-content",
    "content.link": "link",
    "content.relations": "relations",
    "content.annotate": "annotate",
    "table.create": "create-interactive",
    "table.revise": "revise-interactive",
    "table.query": "query-interactive",
    "table.patch": "patch-interactive",
    "files.read": "local-file",
    "files.directory": "directory",
    "browser.control": "browser",
    "reader.import": "reader-import",
  };
  const action = actions[id];
  if (action)
    return id === "files.read"
      ? { ...parameters, action, localFile: { action: "read" } }
      : action === "reader-import"
        ? { action, readerImport: parameters }
        : { ...parameters, action };
  const [domain, name, extra] = id.split(".");
  if (!name || extra) return null;
  const nested: Record<string, [string, string, readonly string[]]> = {
    reader: [
      "reader",
      "reader",
      [
        "catalog",
        "contents",
        "read",
        "marks",
        "mark-add",
        "mark-update",
        "mark-remove",
        "mark-restore",
        "save-position",
        "ocr",
      ],
    ],
    applications: ["applications", "applications", ["list", "launch"]],
    profile: ["profile", "profile", ["read", "update", "propose"]],
    cognitive: [
      "cognitive",
      "cognitive",
      ["list", "describe", "invoke", "read-object", "status", "recover"],
    ],
    projects: [
      "projects",
      "management",
      ["list", "create", "rename", "archive", "restore", "delete"],
    ],
    conversations: [
      "conversations",
      "management",
      ["list", "rename", "archive", "restore"],
    ],
    bookmarks: [
      "bookmarks",
      "bookmarks",
      ["list", "add", "update", "remove", "restore"],
    ],
    "work-tasks": [
      "work-task",
      "workTask",
      [
        "list",
        "create",
        "version",
        "responses",
        "revise",
        "order",
        "reorder",
        "start",
        "runs",
        "run-status",
        "stop",
      ],
    ],
  };
  const route = nested[domain!];
  if (route?.[2].includes(name))
    return { action: route[0], [route[1]]: { ...parameters, action: name } };
  if (domain === "tasks") {
    const taskActions: Record<string, string> = {
      list: "list-tasks",
      create: "create-task",
      revise: "revise-task",
      reorder: "reorder-tasks",
      arrange: "arrange-task",
      start: "start-task",
      cancel: "cancel-task",
      status: "task-status",
      control: "control-task",
      finish: "finish-task",
    };
    if (taskActions[name]) return { ...parameters, action: taskActions[name] };
  }
  if (domain === "script") {
    const commands = [
      "create-production",
      "create-item",
      "revise-item",
      "restore-item",
      "submit-candidate",
      "add-review",
    ];
    return {
      action: "script",
      script: commands.includes(name)
        ? { action: "command", command: { ...parameters, action: name } }
        : { ...parameters, action: name },
    };
  }
  return null;
}

function readerPresentation(args: Record<string, unknown>, state: Workspace) {
  const action = text(args.action);
  const title =
    (
      {
        catalog: "查找书籍",
        contents: "读取书籍目录",
        read: "读取书籍原文",
        marks: "读取阅读标注",
        "mark-add": "添加阅读标注",
        "mark-update": "修改阅读标注",
        "mark-remove": "移除阅读标注",
        "mark-restore": "恢复阅读标注",
        "save-position": "保存阅读进度",
        ocr: "识别书页文字",
      } as Record<string, string>
    )[action] ?? `reader.${action}`;
  const artifact = state.artifacts.find((item) => item.id === args.artifactId);
  // Never label an old read using today's chapter list or renamed title.
  const version =
    artifact?.versions.find((item) => item.revision === args.revision) ??
    (artifact?.revision === args.revision ? artifact : undefined);
  const publication =
    version?.content.kind === "publication" ? version.content : undefined;
  const location = record(args.location);
  const sectionId = text(args.sectionId ?? location.sectionId);
  const section = publication?.sections.find((item) => item.id === sectionId);
  // A volume heading can also contain a long date-range synopsis. Keep its
  // exact leading heading in the scan row, rather than repeating that synopsis
  // on every slice. Other chapter naming formats stay intact.
  const sectionLabel =
    section?.title.match(/^(卷\S{1,16}?【[^】]+】)/u)?.[1] ||
    section?.title ||
    sectionId;
  const scope = [
    version
      ? `《${short(version.title).slice(0, 48)}》`
      : text(args.artifactId),
    typeof args.revision === "number" ? `v${args.revision}` : "",
    short(sectionLabel).slice(0, 48),
  ];
  if (action === "read") {
    const offset = typeof args.offset === "number" ? args.offset : 0;
    const limit = typeof args.limit === "number" ? args.limit : 4000;
    const end = Math.min(offset + limit, section?.characters ?? Infinity);
    scope.push(
      end > offset
        ? `字符 ${(offset + 1).toLocaleString("en-US")}–${end.toLocaleString("en-US")}`
        : `偏移 ${offset.toLocaleString("en-US")} · 最多 ${limit.toLocaleString("en-US")} 字符`,
    );
  }
  if (action === "catalog") scope.push(text(args.query));
  if (!scope.some(Boolean)) scope.push(text(args.markId));
  return { title, detail: short(scope.filter(Boolean).join(" · ")) };
}

/** Read the bounded recent Job window chronologically, without changing which
 * Jobs were retrieved. Updated/completion times do not reorder earlier steps. */
export function executionJobsInReadingOrder(
  jobs: readonly ExecutionSnapshot["jobs"][number][],
): ExecutionSnapshot["jobs"] {
  return jobs
    .map((job) => {
      const milliseconds = Date.parse(job.created_at);
      const valid = Number.isFinite(milliseconds);
      // Runtime timestamps can distinguish two creations inside one millisecond.
      // Date.parse normalizes timezones but drops these remaining nanoseconds.
      const fraction =
        /\.(\d+)(?:Z|[+-]\d{2}:?\d{2})$/i.exec(job.created_at)?.[1] ?? "";
      return {
        job,
        milliseconds: valid ? milliseconds : Number.POSITIVE_INFINITY,
        nanoseconds: valid
          ? Number(fraction.slice(3).padEnd(6, "0").slice(0, 6))
          : 0,
      };
    })
    .sort(
      (a, b) =>
        a.milliseconds - b.milliseconds ||
        a.nanoseconds - b.nanoseconds ||
        a.job.id.localeCompare(b.job.id),
    )
    .map(({ job }) => job);
}

/** The adapter has already bound these strings to the exact Job and returned
 * receipt. Never recover an annotation from raw request JSON or a nearby step. */
export function executionJobPresentation(
  job: ExecutionSnapshot["jobs"][number],
  state: Workspace,
) {
  const fallback = executionPresentation(job.tool_name, job.request, state);
  return {
    ...fallback,
    title: text(job.annotation?.intent) || fallback.title,
    result: job.result_event_id ? text(job.annotation?.result) || null : null,
  };
}

/** Describe the observed request, not an invented outcome or a model summary.
 * Only allowlisted display fields are used; route metadata and credentials stay out. */
export function executionPresentation(
  tool: string,
  request: unknown,
  state: Workspace,
): { title: string; detail: string } {
  const args = record(request);
  if (tool === "terminal") {
    const action = text(args.action);
    const title =
      {
        open: "新建终端会话",
        list: "查看终端会话",
        read: "读取终端屏幕",
        write: "向终端输入命令",
        interrupt: "中断终端前台进程",
        resize: "调整终端尺寸",
        close: "结束终端会话",
      }[action] ?? "终端操作";
    return {
      title,
      detail: short(text(action === "open" ? args.cwd : args.terminal_id)),
    };
  }
  if (!isObjectToolName(tool)) {
    const title =
      {
        read: "读取文件",
        read_file: "读取文件",
        write: "写入文件",
        write_file: "写入文件",
        edit: "修改文件",
        grep: "搜索文件",
        search: "搜索资料",
        exec: "执行命令",
        exec_command: "执行命令",
        list: "浏览目录",
        ls: "浏览目录",
        fetch: "读取网页",
      }[tool] ?? tool;
    // Shell command bodies can contain secrets. Keep them in explicit technical
    // details instead of copying them into a always-visible summary.
    const detail = /exec|shell|command/.test(tool)
      ? text(args.cwd)
      : text(args.path ?? args.file_path ?? args.query);
    return { title, detail: short(detail) };
  }
  const action = text(args.action);
  if (action === "operations") {
    const operation = record(args.operations);
    const id = text(operation.operationId);
    if (operation.action === "list")
      return {
        title: "查找可用操作",
        detail: short(
          [text(operation.domain), text(operation.query)]
            .filter(Boolean)
            .join(" · "),
        ),
      };
    if (operation.action === "describe")
      return { title: "查看操作说明", detail: id };
    const command =
      operation.action === "invoke"
        ? operationRequest(id, record(operation.parameters))
        : null;
    return command
      ? executionPresentation(tool, command, state)
      : { title: id || "未标明具体操作", detail: "" };
  }
  if (action === "reader")
    return readerPresentation(record(args.reader), state);
  if (action === "reader-import") {
    const source = record(record(args.readerImport).source);
    return {
      title: "导入书籍",
      detail: short(text(source.path) || text(source.assetId)),
    };
  }
  if (action === "script") {
    const script = record(args.script),
      command = record(script.command);
    const name = text(script.action);
    const production = state.scriptProductions.find(
      (p) => p.id === (command.productionId ?? script.productionId),
    );
    const item = production?.items.find(
      (i) => i.id === (command.itemId ?? command.targetId ?? script.itemId),
    );
    const kind =
      scriptKindLabels[command.kind as keyof typeof scriptKindLabels] ?? "条目";
    const verb = name === "command" ? text(command.action) : name;
    const title =
      {
        list: "查看剧本列表",
        "read-production": "读取剧本",
        "read-item": "读取剧本条目",
        "read-source": "读取原文",
        "read-generation": "读取创作要求",
        "read-workflow": "读取编剧流程",
        "prepare-workflow": "准备创作范围",
        "submit-workflow": "提交创作结果",
        "list-candidates": "查看历史候选稿",
        "read-candidate": "读取历史候选稿",
        "read-results": "查看创作结果",
        "read-result": "读取创作结果",
        issues: "检查剧本",
        impact: "分析改动影响",
        "create-production": "新建剧本",
        "create-item": `新建${kind}`,
        "revise-item": "修改剧本条目",
        "restore-item": "恢复剧本历史版本",
        "submit-candidate": "提交候选稿",
        "add-review": "提交审查意见",
      }[verb] ?? `剧本 · ${verb || "操作"}`;
    const target =
      text(command.title) ||
      text(record(command.draft).title) ||
      (item && currentScriptDraft(item).title) ||
      production?.title;
    const detail = target
      ? [
          production?.title && production.title !== target
            ? production.title
            : "",
          target,
        ]
          .filter(Boolean)
          .join(" / ")
      : name === "list"
        ? "当前工作空间"
        : "";
    return { title, detail: short(detail) };
  }
  const labels: Record<string, string> = {
    "read-input": "读取用户输入",
    "connection-status": "检查连接",
    list: "浏览内容",
    search: "搜索内容",
    read: "读取内容",
    "create-document": "新建文档",
    "revise-document": "修改文档",
    "create-interactive": "新建表格",
    "revise-interactive": "修改表格",
    "create-task": "创建事项",
    "revise-task": "修改事项",
    "list-tasks": "查看事项",
    "reorder-tasks": "调整事项顺序",
    "arrange-task": "安排事项",
    "start-task": "开始事项",
    "cancel-task": "取消事项",
    "task-status": "查看事项状态",
    "control-task": "调整事项执行",
    "finish-task": "提交事项结果",
    "organize-content": "整理内容",
    link: "关联内容",
    annotate: "添加批注",
    "publish-understanding": "更新工作理解",
    "list-applications": "查看应用",
    "launch-application": "打开应用",
    "conversation-search": "搜索对话消息",
    relations: "读取内容关联",
    "query-interactive": "查询表格记录",
    "patch-interactive": "修改表格记录",
  };
  const nouns: Record<string, string> = {
    projects: "项目",
    conversations: "会话",
    bookmarks: "浏览器收藏",
    directory: "目录",
    "local-file": "本地文件",
    browser: "浏览器",
    applications: "应用",
    profile: "智能体资料",
    cognitive: "认知应用",
    "work-task": "事项",
  };
  const verbs: Record<string, string> = {
    list: "查看",
    read: "读取",
    create: "新建",
    rename: "重命名",
    archive: "归档",
    restore: "恢复",
    delete: "删除",
    update: "更新",
    write: "写入",
    search: "搜索",
    open: "打开",
    navigate: "访问",
    status: "查看",
    inspect: "检查",
    launch: "打开",
    add: "添加",
    remove: "移除",
    propose: "提议修改",
    describe: "查看操作说明 · ",
    invoke: "调用",
    "read-object": "读取原件 · ",
    recover: "核对回执 · ",
    version: "读取版本 · ",
    revise: "修改",
    order: "查看排序 · ",
    reorder: "调整顺序 · ",
    start: "请求执行",
    runs: "查看执行记录 · ",
    responses: "查看回复 · ",
    "run-status": "查看执行状态 · ",
    stop: "停止",
  };
  const nested = record(
    args.management ??
      args.bookmarks ??
      args.directory ??
      args.localFile ??
      args.browser ??
      args.applications ??
      args.profile ??
      args.cognitive ??
      args.workTask,
  );
  const nestedAction =
    text(nested.action) ||
    text(nested.operation) ||
    text(record(nested.action).type);
  const browserTitle =
    (
      {
        snapshot: "读取网页界面",
        fill: "填写网页表单",
        click: "点击网页元素",
      } as Record<string, string>
    )[nestedAction] ?? (nested.requestId ? "读取网页操作结果" : "查看授权网页");
  const title =
    labels[action] ??
    (action === "browser"
      ? browserTitle
      : nouns[action]
        ? `${verbs[nestedAction] ?? "操作"}${nouns[action]}`
        : action || tool);
  const artifact = state.artifacts.find(
    (a) =>
      a.id ===
      (args.artifactId ??
        args.taskId ??
        nested.artifactId ??
        record(args.content).id),
  );
  const production = state.scriptProductions.find(
    (p) =>
      record(args.content).kind === "script" &&
      p.id === record(args.content).id,
  );
  const detail =
    text(args.title ?? nested.title) ||
    production?.title ||
    artifact?.title ||
    text(
      args.query ??
        args.path ??
        nested.path ??
        nested.query ??
        nested.operationId ??
        nested.applicationId ??
        nested.taskId ??
        nested.conversationId ??
        nested.projectId,
    );
  return { title, detail: short(detail) };
}

/** Read only a verified response envelope; an invocation succeeding does not
 * mean a domain operation returned ok, and a candidate is not an accepted draft. */
export function executionResultSummary(value: string): string | null {
  try {
    const result = record(JSON.parse(value));
    if (result.ok === false)
      return text(result.error) || "操作未成功，请查看返回详情。";
    if (result.ok !== true) return null;
    if (Array.isArray(result.productions))
      return `找到 ${typeof result.total === "number" ? result.total : result.productions.length} 部剧本${result.hasMore ? "，当前结果未全部列出" : ""}。`;
    if (result.receipt && text(record(result.receipt).entityId))
      return "已保存，操作回执已确认。";
    if (Array.isArray(result.items))
      return `返回 ${result.items.length} 项结果。`;
    return null;
  } catch {
    return null;
  }
}

/** Streaming parameter generation is not a completed execution. Keep the
 * live protocol's compatibility labels and incomplete-JSON fallback distinct. */
export function liveToolPresentation(
  tool: NonNullable<LiveMessage["tool"]>,
  state: Workspace,
): Readonly<{
  title: string;
  detail: string | undefined;
  statusLabel: string;
}> {
  let presentation;
  try {
    presentation = executionPresentation(
      tool.name,
      JSON.parse(tool.arguments),
      state,
    );
  } catch {
    /* Streaming arguments may be incomplete. */
  }
  const status =
    (
      {
        generating: "正在生成参数",
        pending: "参数已生成",
        running: "执行中",
        queued: "排队中",
        waiting_approval: "等待审批",
        approval_required: "等待审批",
        success: "已完成",
        succeeded: "已完成",
        completed: "已完成",
        failed: "失败",
        error: "失败",
        cancelled: "已取消",
      } as Record<string, string>
    )[tool.status] ?? tool.status;
  return {
    title: presentation?.title ?? tool.name ?? "工具调用",
    detail: presentation?.detail,
    statusLabel: status,
  };
}

/** A persisted stop request takes precedence only while its Job is active;
 * terminal outcomes and the snapshot's approval/lost labels stay authoritative. */
export function executionSnapshotJobPresentation(
  job: ExecutionSnapshot["jobs"][number],
  state: Workspace,
): Readonly<{
  title: string;
  detail: string;
  result: string | null;
  statusLabel: string;
}> {
  const presentation = executionJobPresentation(job, state);
  return {
    ...presentation,
    statusLabel:
      job.cancel_requested_at &&
      ["queued", "waiting_approval", "running"].includes(job.status)
        ? "正在停止"
        : jobStatusLabel[job.status],
  };
}
