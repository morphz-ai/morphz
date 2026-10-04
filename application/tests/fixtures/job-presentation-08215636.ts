// Independent actual Git 0821563681516b78f63e2d79d1fc79bb782bb07d; raw spans are finite algorithm/provenance oracles.
// No current whole-file hashes are enforced by ordinary CI.
export const jobPresentationOriginal = {
  git: "0821563681516b78f63e2d79d1fc79bb782bb07d",
  provenance: {
    Owner: {
      path: "application/apps/web/src/execution-presentation.ts",
      bytes: 8493,
      sha256:
        "1043f1c9219908de0bffb94a775807d9f7d687f76a5bbce4f39319510a3f9271",
    },
    Conversation: {
      path: "application/apps/web/src/Conversation.tsx",
      bytes: 51088,
      sha256:
        "4e5e0fd2638e27deb312f6df125ed367412cc595d7175668bbb6a24eda70ded2",
    },
    Dialog: {
      path: "application/apps/web/src/ExecutionDialog.tsx",
      bytes: 17727,
      sha256:
        "bc8e37b4d92e9b1ccd4de336e50170138c4f62f634d6a534c7ea2b8373c6dfdc",
    },
    Sidebar: {
      path: "application/apps/web/src/ExecutionSidebar.tsx",
      bytes: 19196,
      sha256:
        "a60f7813cb98259e36a1d383cc99ed98ebde0766ed2e19fe1814df5e2a344a97",
    },
    JobCore: {
      path: "application/packages/core/src/execution.ts",
      bytes: 3921,
      sha256:
        "44317634e11451ce6f33dea3eb306d4139b7e770f1942cafbeda530aa02af309",
    },
  },
  spans: {
    executionJobsInReadingOrder: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 834,
      end: 1774,
      bytes: 940,
      sha256:
        "2fd05067a7849413c1837888e1a374ad68541e0741c58872357a85cc8accdd11",
      raw: 'export function executionJobsInReadingOrder(\n  jobs: readonly ExecutionSnapshot["jobs"][number][],\n): ExecutionSnapshot["jobs"] {\n  return jobs\n    .map((job) => {\n      const milliseconds = Date.parse(job.created_at);\n      const valid = Number.isFinite(milliseconds);\n      // Runtime timestamps can distinguish two creations inside one millisecond.\n      // Date.parse normalizes timezones but drops these remaining nanoseconds.\n      const fraction =\n        /\\.(\\d+)(?:Z|[+-]\\d{2}:?\\d{2})$/i.exec(job.created_at)?.[1] ?? "";\n      return {\n        job,\n        milliseconds: valid ? milliseconds : Number.POSITIVE_INFINITY,\n        nanoseconds: valid\n          ? Number(fraction.slice(3).padEnd(6, "0").slice(0, 6))\n          : 0,\n      };\n    })\n    .sort(\n      (a, b) =>\n        a.milliseconds - b.milliseconds ||\n        a.nanoseconds - b.nanoseconds ||\n        a.job.id.localeCompare(b.job.id),\n    )\n    .map(({ job }) => job);\n}',
    },
    executionJobPresentation: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 1937,
      end: 2294,
      bytes: 357,
      sha256:
        "61118026b82f5f51f2e7b87dcd0141b17bf45801c8a7cac557616b1ffcf7320e",
      raw: 'export function executionJobPresentation(\n  job: ExecutionSnapshot["jobs"][number],\n  state: Workspace,\n) {\n  const fallback = executionPresentation(job.tool_name, job.request, state);\n  return {\n    ...fallback,\n    title: text(job.annotation?.intent) || fallback.title,\n    result: job.result_event_id ? text(job.annotation?.result) || null : null,\n  };\n}',
    },
    executionPresentation: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 2464,
      end: 6961,
      bytes: 5107,
      sha256:
        "a59516e740db93727e1726990be2c81e21fd917c99f6da9756ebc8e9263e1f1a",
      raw: 'export function executionPresentation(\n  tool: string,\n  request: unknown,\n  state: Workspace,\n) {\n  const args = record(request);\n  if (!isObjectToolName(tool)) {\n    const title =\n      {\n        read: "读取文件",\n        read_file: "读取文件",\n        write: "写入文件",\n        write_file: "写入文件",\n        edit: "修改文件",\n        grep: "搜索文件",\n        search: "搜索资料",\n        exec: "执行命令",\n        exec_command: "执行命令",\n        list: "浏览目录",\n        ls: "浏览目录",\n        fetch: "读取网页",\n      }[tool] ?? tool;\n    // Shell command bodies can contain secrets. Keep them in explicit technical\n    // details instead of copying them into a always-visible summary.\n    const detail = /exec|shell|command/.test(tool)\n      ? text(args.cwd)\n      : text(args.path ?? args.file_path ?? args.query);\n    return { title, detail: short(detail) };\n  }\n  const action = text(args.action);\n  if (action === "script") {\n    const script = record(args.script),\n      command = record(script.command);\n    const name = text(script.action);\n    const production = state.scriptProductions.find(\n      (p) => p.id === (command.productionId ?? script.productionId),\n    );\n    const item = production?.items.find(\n      (i) => i.id === (command.itemId ?? command.targetId ?? script.itemId),\n    );\n    const kind =\n      scriptKindLabels[command.kind as keyof typeof scriptKindLabels] ?? "条目";\n    const verb = name === "command" ? text(command.action) : name;\n    const title =\n      {\n        list: "查看剧本列表",\n        "read-production": "读取剧本",\n        "read-item": "读取剧本条目",\n        "read-source": "读取原文",\n        "read-generation": "读取创作要求",\n        "read-workflow": "读取编剧流程",\n        "submit-workflow": "提交创作结果",\n        "read-results": "查看创作结果",\n        "read-result": "读取创作结果",\n        issues: "检查剧本",\n        impact: "分析改动影响",\n        "create-production": "新建剧本",\n        "create-item": `新建${kind}`,\n        "submit-candidate": "提交候选稿",\n        "add-review": "提交审查意见",\n      }[verb] ?? `剧本 · ${verb || "操作"}`;\n    const target =\n      text(command.title) ||\n      text(record(command.draft).title) ||\n      (item && currentScriptDraft(item).title) ||\n      production?.title;\n    const detail = target\n      ? [\n          production?.title && production.title !== target\n            ? production.title\n            : "",\n          target,\n        ]\n          .filter(Boolean)\n          .join(" / ")\n      : name === "list"\n        ? "当前工作空间"\n        : "";\n    return { title, detail: short(detail) };\n  }\n  const labels: Record<string, string> = {\n    "read-input": "读取用户输入",\n    "connection-status": "检查连接",\n    list: "浏览内容",\n    search: "搜索内容",\n    read: "读取内容",\n    "create-document": "新建文档",\n    "revise-document": "修改文档",\n    "create-interactive": "新建表格",\n    "revise-interactive": "修改表格",\n    "create-task": "创建事项",\n    "revise-task": "修改事项",\n    "list-tasks": "查看事项",\n    "reorder-tasks": "调整事项顺序",\n    "arrange-task": "安排事项",\n    "start-task": "开始事项",\n    "cancel-task": "取消事项",\n    "task-status": "查看事项状态",\n    "control-task": "调整事项执行",\n    "finish-task": "提交事项结果",\n    "organize-content": "整理内容",\n    link: "关联内容",\n    annotate: "添加批注",\n    "publish-understanding": "更新工作理解",\n    "list-applications": "查看应用",\n    "launch-application": "打开应用",\n  };\n  const nouns: Record<string, string> = {\n    projects: "项目",\n    conversations: "会话",\n    bookmarks: "浏览器收藏",\n    directory: "目录",\n    "local-file": "本地文件",\n    browser: "浏览器",\n  };\n  const verbs: Record<string, string> = {\n    list: "查看",\n    read: "读取",\n    create: "新建",\n    rename: "重命名",\n    archive: "归档",\n    restore: "恢复",\n    delete: "删除",\n    update: "更新",\n    write: "写入",\n    search: "搜索",\n    open: "打开",\n    navigate: "访问",\n    status: "查看",\n    inspect: "检查",\n  };\n  const nested = record(\n    args.management ??\n      args.bookmarks ??\n      args.directory ??\n      args.localFile ??\n      args.browser,\n  );\n  const title =\n    labels[action] ??\n    (nouns[action]\n      ? `${verbs[text(nested.action)] ?? "操作"}${nouns[action]}`\n      : `工作对象 · ${action || "操作"}`);\n  const artifact = state.artifacts.find(\n    (a) => a.id === (args.artifactId ?? args.taskId ?? record(args.content).id),\n  );\n  const production = state.scriptProductions.find(\n    (p) =>\n      record(args.content).kind === "script" &&\n      p.id === record(args.content).id,\n  );\n  const detail =\n    text(args.title ?? nested.title) ||\n    production?.title ||\n    artifact?.title ||\n    text(args.query ?? args.path ?? nested.path);\n  return { title, detail: short(detail) };\n}',
    },
    executionResultSummary: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 7126,
      end: 7786,
      bytes: 756,
      sha256:
        "f471c90378431cd7984470ad7f832a236db82e198ab7d07f3806c0e16611b231",
      raw: 'export function executionResultSummary(value: string): string | null {\n  try {\n    const result = record(JSON.parse(value));\n    if (result.ok === false)\n      return text(result.error) || "操作未成功，请查看返回详情。";\n    if (result.ok !== true) return null;\n    if (Array.isArray(result.productions))\n      return `找到 ${typeof result.total === "number" ? result.total : result.productions.length} 部剧本${result.hasMore ? "，当前结果未全部列出" : ""}。`;\n    if (result.receipt && text(record(result.receipt).entityId))\n      return "已保存，操作回执已确认。";\n    if (Array.isArray(result.items))\n      return `返回 ${result.items.length} 项结果。`;\n    return null;\n  } catch {\n    return null;\n  }\n}',
    },
    record: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 342,
      end: 514,
      bytes: 172,
      sha256:
        "e0c29eff9a8b4614933f8957664fb884f3b534dad839d91e5b77bd5910901c5f",
      raw: 'const record = (value: unknown): Record<string, unknown> =>\n  value && typeof value === "object" && !Array.isArray(value)\n    ? (value as Record<string, unknown>)\n    : {};',
    },
    text: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 515,
      end: 596,
      bytes: 81,
      sha256:
        "006699a2474db3bd0c8175256e9a8b877bf78b5cc6ea31e6a152221225a7c917",
      raw: 'const text = (value: unknown) =>\n  typeof value === "string" ? value.trim() : "";',
    },
    short: {
      file: "application/apps/web/src/execution-presentation.ts",
      start: 597,
      end: 671,
      bytes: 74,
      sha256:
        "9855094f7795dd170c4c27a36aca0690ca71fb92c47581805901a1a8d826d870",
      raw: 'const short = (value: string) => value.replace(/\\s+/g, " ").slice(0, 160);',
    },
    ToolMessage: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 48372,
      end: 50078,
      bytes: 1825,
      sha256:
        "62f14cf6ef065213bca88833c2cbfd7e75ad058d6d5a5be782999b0080d9f4a5",
      raw: 'export function ToolMessage({\n  message,\n  state,\n}: {\n  message: LiveMessage;\n  state: Workspace;\n}) {\n  const tool = message.tool!;\n  let presentation;\n  try {\n    presentation = executionPresentation(\n      tool.name,\n      JSON.parse(tool.arguments),\n      state,\n    );\n  } catch {\n    /* Streaming arguments may be incomplete. */\n  }\n  const status =\n    (\n      {\n        generating: "正在生成参数",\n        pending: "参数已生成",\n        running: "执行中",\n        queued: "排队中",\n        waiting_approval: "等待审批",\n        approval_required: "等待审批",\n        success: "已完成",\n        succeeded: "已完成",\n        completed: "已完成",\n        failed: "失败",\n        error: "失败",\n        cancelled: "已取消",\n      } as Record<string, string>\n    )[tool.status] ?? tool.status;\n  return (\n    <details className="message-tool" data-tool-status={tool.status}>\n      <summary>\n        <ChevronRight className="tool-chevron" size={14} />\n        <Wrench size={14} aria-hidden="true" />\n        <span className="tool-name" title={presentation?.detail}>\n          {presentation?.title ?? tool.name ?? "工具调用"}\n          {presentation?.detail ? ` · ${presentation.detail}` : ""}\n        </span>\n        <span className="tool-state">{status}</span>\n      </summary>\n      <div className="tool-details">\n        {tool.arguments && (\n          <>\n            <span className="tool-detail-label">参数</span>\n            <pre>{tool.arguments}</pre>\n          </>\n        )}\n        {tool.result !== undefined && (\n          <>\n            <span className="tool-detail-label">结果</span>\n            <pre>{tool.result || "无文本输出"}</pre>\n          </>\n        )}\n        {tool.truncated && <small>内容已截断</small>}\n      </div>\n    </details>\n  );\n}',
    },
    liveTool: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 48478,
      end: 48505,
      bytes: 27,
      sha256:
        "67600d7d56e4cf28f065a4cfa3f8c3ad7662b6e9d510060a2e72a4d008350d7b",
      raw: "const tool = message.tool!;",
    },
    livePresentationDeclaration: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 48508,
      end: 48525,
      bytes: 17,
      sha256:
        "effb7821fb4a8d20f105397feadd5ad4372d622a63ebd02f8f1da9f672a4c2ed",
      raw: "let presentation;",
    },
    liveParse: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 48528,
      end: 48711,
      bytes: 183,
      sha256:
        "77b1ec2d25568d3688f6eb2bda29b4752dc5a276c7e341312738fbcbf8b7d03b",
      raw: "try {\n    presentation = executionPresentation(\n      tool.name,\n      JSON.parse(tool.arguments),\n      state,\n    );\n  } catch {\n    /* Streaming arguments may be incomplete. */\n  }",
    },
    liveStatus: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 48714,
      end: 49128,
      bytes: 496,
      sha256:
        "11a43443ca56549a516b167a449e750703b6c540f470d53066a64469f36ea360",
      raw: 'const status =\n    (\n      {\n        generating: "正在生成参数",\n        pending: "参数已生成",\n        running: "执行中",\n        queued: "排队中",\n        waiting_approval: "等待审批",\n        approval_required: "等待审批",\n        success: "已完成",\n        succeeded: "已完成",\n        completed: "已完成",\n        failed: "失败",\n        error: "失败",\n        cancelled: "已取消",\n      } as Record<string, string>\n    )[tool.status] ?? tool.status;',
    },
    liveTitle: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 49411,
      end: 49453,
      bytes: 50,
      sha256:
        "8054aae024f5d5021eb4a7db455e5ad23cbb1e154515663b8f2254edf70944eb",
      raw: 'presentation?.title ?? tool.name ?? "工具调用"',
    },
    liveDetail: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 49466,
      end: 49521,
      bytes: 56,
      sha256:
        "edbdfc587307c35498296e9f44d90f66483d74010a4143cb0931358164850526",
      raw: 'presentation?.detail ? ` · ${presentation.detail}` : ""',
    },
    liveTooltip: {
      file: "application/apps/web/src/Conversation.tsx",
      start: 49377,
      end: 49397,
      bytes: 20,
      sha256:
        "ee2d2933e0c4ddf96acf64bacc0ee114ea3f7e2c4908f3a45c2d5604c3436feb",
      raw: "presentation?.detail",
    },
    snapshotStatus: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 11898,
      end: 12164,
      bytes: 274,
      sha256:
        "7857bb3ca18b89b15e081a878499acd26c8630a361ec1fd373271856af435158",
      raw: 'job.cancel_requested_at &&\n                          ["queued", "waiting_approval", "running"].includes(\n                            job.status,\n                          )\n                            ? "正在停止"\n                            : jobStatusLabel[job.status]',
    },
    snapshotCall: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 11309,
      end: 11423,
      bytes: 114,
      sha256:
        "b3e15997c74dccfd690a192dfd8e3d71430ad50c73b12245ffe1b77350ce5c74",
      raw: "executionJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  )",
    },
    snapshotLabelTable: {
      file: "application/packages/core/src/execution.ts",
      start: 3645,
      end: 3874,
      bytes: 275,
      sha256:
        "4168dd59d44647a11ac7b767cb9c687cd7c54d0bed883640166e1c950f353cfe",
      raw: 'export const jobStatusLabel: Record<\n  z.infer<typeof jobSchema>["status"],\n  string\n> = {\n  queued: "排队中",\n  waiting_approval: "等待批准",\n  running: "执行中",\n  succeeded: "已完成",\n  failed: "失败",\n  cancelled: "已取消",\n  lost: "需核对结果",\n};',
    },
  },
  tables: {
    live: [
      ["generating", "正在生成参数"],
      ["pending", "参数已生成"],
      ["running", "执行中"],
      ["queued", "排队中"],
      ["waiting_approval", "等待审批"],
      ["approval_required", "等待审批"],
      ["success", "已完成"],
      ["succeeded", "已完成"],
      ["completed", "已完成"],
      ["failed", "失败"],
      ["error", "失败"],
      ["cancelled", "已取消"],
    ],
    snapshot: [
      ["queued", "排队中"],
      ["waiting_approval", "等待批准"],
      ["running", "执行中"],
      ["succeeded", "已完成"],
      ["failed", "失败"],
      ["cancelled", "已取消"],
      ["lost", "需核对结果"],
    ],
  },
} as const;
