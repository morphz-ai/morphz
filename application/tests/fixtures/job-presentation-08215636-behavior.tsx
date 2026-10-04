// Independent complete originals captured from actual committed Git 08215636.
// No CI Git dependency and no current-neighbor full-file hash lock.
// Fixed component adapters only rename the export and relocate imports.
export const fixedJobMetadata = {
  git: "0821563681516b78f63e2d79d1fc79bb782bb07d",
  sources: {
    "execution-presentation.ts": {
      bytes: 8493,
      sha256:
        "1043f1c9219908de0bffb94a775807d9f7d687f76a5bbce4f39319510a3f9271",
    },
    "Conversation.tsx": {
      bytes: 51088,
      sha256:
        "4e5e0fd2638e27deb312f6df125ed367412cc595d7175668bbb6a24eda70ded2",
    },
    "ExecutionDialog.tsx": {
      bytes: 17727,
      sha256:
        "bc8e37b4d92e9b1ccd4de336e50170138c4f62f634d6a534c7ea2b8373c6dfdc",
    },
    "execution-thread-groups.ts": {
      bytes: 2387,
      sha256:
        "92e0dec6ca37212513187e8435d38dadd48c3315cc5c07e34bcfa15f0e9661d8",
    },
    "useObservedRead.ts": {
      bytes: 2020,
      sha256:
        "cf3ff430ad1de70fe2a76ff8e64d77b40a23ac124212a41e85880c7e19cc3517",
    },
    "observed-read.ts": {
      bytes: 2698,
      sha256:
        "4bfa2b10ae6f6abfc370a700bea1b16ee509a1f117e6679fbccbdb7f4e0798c1",
    },
    "useModal.ts": {
      bytes: 5140,
      sha256:
        "f9f45b71766ac08a3ae47ff3a5b4300a61193f2fef17e76f99ab63924781cac4",
    },
    "execution-activity.ts": {
      bytes: 8295,
      sha256:
        "1703af02294ae2058366f8714da67be0f9b73ebd77fe0d218b61863204a6494c",
    },
    "ExecutionStatusIcon.tsx": {
      bytes: 893,
      sha256:
        "48bf4e14f13abe18d136a862dfa3b3afc859e6bea257209dd8c8649b06110d93",
    },
    "ApprovalCard.tsx": {
      bytes: 5430,
      sha256:
        "dd859641e62d25f88be87c369a9f896bfbdbae56b46ef98007deec5123cb9f8e",
    },
  },
  spans: {
    ToolMessage: {
      bytes: 1825,
      sha256:
        "62f14cf6ef065213bca88833c2cbfd7e75ad058d6d5a5be782999b0080d9f4a5",
    },
    ExecutionDialog: {
      bytes: 16916,
      sha256:
        "479b0e98af26b0bd787f99b21e6f5f562b8eec61ead894b79d73b1ca49a07d9f",
    },
    jobRow: {
      bytes: 5696,
      sha256:
        "716c1df4b83e5f160f4306003b9950720c4603171596ec5ad85b3de1892f8c68",
    },
    snapshotCall: {
      bytes: 129,
      sha256:
        "5d25a03c7c49d2a8bba9e50a603d896d45b22b54f46d208712bfbf034f22a67e",
    },
    snapshotStatus: {
      bytes: 274,
      sha256:
        "7857bb3ca18b89b15e081a878499acd26c8630a361ec1fd373271856af435158",
    },
    liveBody: {
      bytes: 705,
      sha256:
        "8f47b588106381048053adefc3710d03d98ba421fa6f2d382fa42acafaf53938",
    },
    liveTitle: {
      bytes: 50,
      sha256:
        "8054aae024f5d5021eb4a7db455e5ad23cbb1e154515663b8f2254edf70944eb",
    },
    liveDetail: {
      bytes: 20,
      sha256:
        "ee2d2933e0c4ddf96acf64bacc0ee114ea3f7e2c4908f3a45c2d5604c3436feb",
    },
  },
} as const;
export const fixedJobSources = {
  pure: 'import { isObjectToolName } from "../../../packages/core/src/application-names.js";\nimport type { ExecutionSnapshot } from "../../../packages/core/src/execution.js";\nimport type { Workspace } from "../../../packages/core/src/model.js";\nimport {\n  currentScriptDraft,\n  scriptKindLabels,\n} from "../../../packages/core/src/script-studio.js";\n\nconst record = (value: unknown): Record<string, unknown> =>\n  value && typeof value === "object" && !Array.isArray(value)\n    ? (value as Record<string, unknown>)\n    : {};\nconst text = (value: unknown) =>\n  typeof value === "string" ? value.trim() : "";\nconst short = (value: string) => value.replace(/\\s+/g, " ").slice(0, 160);\n\n/** Read the bounded recent Job window chronologically, without changing which\n * Jobs were retrieved. Updated/completion times do not reorder earlier steps. */\nexport function executionJobsInReadingOrder(\n  jobs: readonly ExecutionSnapshot["jobs"][number][],\n): ExecutionSnapshot["jobs"] {\n  return jobs\n    .map((job) => {\n      const milliseconds = Date.parse(job.created_at);\n      const valid = Number.isFinite(milliseconds);\n      // Runtime timestamps can distinguish two creations inside one millisecond.\n      // Date.parse normalizes timezones but drops these remaining nanoseconds.\n      const fraction =\n        /\\.(\\d+)(?:Z|[+-]\\d{2}:?\\d{2})$/i.exec(job.created_at)?.[1] ?? "";\n      return {\n        job,\n        milliseconds: valid ? milliseconds : Number.POSITIVE_INFINITY,\n        nanoseconds: valid\n          ? Number(fraction.slice(3).padEnd(6, "0").slice(0, 6))\n          : 0,\n      };\n    })\n    .sort(\n      (a, b) =>\n        a.milliseconds - b.milliseconds ||\n        a.nanoseconds - b.nanoseconds ||\n        a.job.id.localeCompare(b.job.id),\n    )\n    .map(({ job }) => job);\n}\n\n/** The adapter has already bound these strings to the exact Job and returned\n * receipt. Never recover an annotation from raw request JSON or a nearby step. */\nexport function executionJobPresentation(\n  job: ExecutionSnapshot["jobs"][number],\n  state: Workspace,\n) {\n  const fallback = executionPresentation(job.tool_name, job.request, state);\n  return {\n    ...fallback,\n    title: text(job.annotation?.intent) || fallback.title,\n    result: job.result_event_id ? text(job.annotation?.result) || null : null,\n  };\n}\n\n/** Describe the observed request, not an invented outcome or a model summary.\n * Only allowlisted display fields are used; route metadata and credentials stay out. */\nexport function executionPresentation(\n  tool: string,\n  request: unknown,\n  state: Workspace,\n) {\n  const args = record(request);\n  if (!isObjectToolName(tool)) {\n    const title =\n      {\n        read: "读取文件",\n        read_file: "读取文件",\n        write: "写入文件",\n        write_file: "写入文件",\n        edit: "修改文件",\n        grep: "搜索文件",\n        search: "搜索资料",\n        exec: "执行命令",\n        exec_command: "执行命令",\n        list: "浏览目录",\n        ls: "浏览目录",\n        fetch: "读取网页",\n      }[tool] ?? tool;\n    // Shell command bodies can contain secrets. Keep them in explicit technical\n    // details instead of copying them into a always-visible summary.\n    const detail = /exec|shell|command/.test(tool)\n      ? text(args.cwd)\n      : text(args.path ?? args.file_path ?? args.query);\n    return { title, detail: short(detail) };\n  }\n  const action = text(args.action);\n  if (action === "script") {\n    const script = record(args.script),\n      command = record(script.command);\n    const name = text(script.action);\n    const production = state.scriptProductions.find(\n      (p) => p.id === (command.productionId ?? script.productionId),\n    );\n    const item = production?.items.find(\n      (i) => i.id === (command.itemId ?? command.targetId ?? script.itemId),\n    );\n    const kind =\n      scriptKindLabels[command.kind as keyof typeof scriptKindLabels] ?? "条目";\n    const verb = name === "command" ? text(command.action) : name;\n    const title =\n      {\n        list: "查看剧本列表",\n        "read-production": "读取剧本",\n        "read-item": "读取剧本条目",\n        "read-source": "读取原文",\n        "read-generation": "读取创作要求",\n        "read-workflow": "读取编剧流程",\n        "submit-workflow": "提交创作结果",\n        "read-results": "查看创作结果",\n        "read-result": "读取创作结果",\n        issues: "检查剧本",\n        impact: "分析改动影响",\n        "create-production": "新建剧本",\n        "create-item": `新建${kind}`,\n        "submit-candidate": "提交候选稿",\n        "add-review": "提交审查意见",\n      }[verb] ?? `剧本 · ${verb || "操作"}`;\n    const target =\n      text(command.title) ||\n      text(record(command.draft).title) ||\n      (item && currentScriptDraft(item).title) ||\n      production?.title;\n    const detail = target\n      ? [\n          production?.title && production.title !== target\n            ? production.title\n            : "",\n          target,\n        ]\n          .filter(Boolean)\n          .join(" / ")\n      : name === "list"\n        ? "当前工作空间"\n        : "";\n    return { title, detail: short(detail) };\n  }\n  const labels: Record<string, string> = {\n    "read-input": "读取用户输入",\n    "connection-status": "检查连接",\n    list: "浏览内容",\n    search: "搜索内容",\n    read: "读取内容",\n    "create-document": "新建文档",\n    "revise-document": "修改文档",\n    "create-interactive": "新建表格",\n    "revise-interactive": "修改表格",\n    "create-task": "创建事项",\n    "revise-task": "修改事项",\n    "list-tasks": "查看事项",\n    "reorder-tasks": "调整事项顺序",\n    "arrange-task": "安排事项",\n    "start-task": "开始事项",\n    "cancel-task": "取消事项",\n    "task-status": "查看事项状态",\n    "control-task": "调整事项执行",\n    "finish-task": "提交事项结果",\n    "organize-content": "整理内容",\n    link: "关联内容",\n    annotate: "添加批注",\n    "publish-understanding": "更新工作理解",\n    "list-applications": "查看应用",\n    "launch-application": "打开应用",\n  };\n  const nouns: Record<string, string> = {\n    projects: "项目",\n    conversations: "会话",\n    bookmarks: "浏览器收藏",\n    directory: "目录",\n    "local-file": "本地文件",\n    browser: "浏览器",\n  };\n  const verbs: Record<string, string> = {\n    list: "查看",\n    read: "读取",\n    create: "新建",\n    rename: "重命名",\n    archive: "归档",\n    restore: "恢复",\n    delete: "删除",\n    update: "更新",\n    write: "写入",\n    search: "搜索",\n    open: "打开",\n    navigate: "访问",\n    status: "查看",\n    inspect: "检查",\n  };\n  const nested = record(\n    args.management ??\n      args.bookmarks ??\n      args.directory ??\n      args.localFile ??\n      args.browser,\n  );\n  const title =\n    labels[action] ??\n    (nouns[action]\n      ? `${verbs[text(nested.action)] ?? "操作"}${nouns[action]}`\n      : `工作对象 · ${action || "操作"}`);\n  const artifact = state.artifacts.find(\n    (a) => a.id === (args.artifactId ?? args.taskId ?? record(args.content).id),\n  );\n  const production = state.scriptProductions.find(\n    (p) =>\n      record(args.content).kind === "script" &&\n      p.id === record(args.content).id,\n  );\n  const detail =\n    text(args.title ?? nested.title) ||\n    production?.title ||\n    artifact?.title ||\n    text(args.query ?? args.path ?? nested.path);\n  return { title, detail: short(detail) };\n}\n\n/** Read only a verified response envelope; an invocation succeeding does not\n * mean a domain operation returned ok, and a candidate is not an accepted draft. */\nexport function executionResultSummary(value: string): string | null {\n  try {\n    const result = record(JSON.parse(value));\n    if (result.ok === false)\n      return text(result.error) || "操作未成功，请查看返回详情。";\n    if (result.ok !== true) return null;\n    if (Array.isArray(result.productions))\n      return `找到 ${typeof result.total === "number" ? result.total : result.productions.length} 部剧本${result.hasMore ? "，当前结果未全部列出" : ""}。`;\n    if (result.receipt && text(record(result.receipt).entityId))\n      return "已保存，操作回执已确认。";\n    if (Array.isArray(result.items))\n      return `返回 ${result.items.length} 项结果。`;\n    return null;\n  } catch {\n    return null;\n  }\n}\n',
  ToolMessage:
    'export function ToolMessage({\n  message,\n  state,\n}: {\n  message: LiveMessage;\n  state: Workspace;\n}) {\n  const tool = message.tool!;\n  let presentation;\n  try {\n    presentation = executionPresentation(\n      tool.name,\n      JSON.parse(tool.arguments),\n      state,\n    );\n  } catch {\n    /* Streaming arguments may be incomplete. */\n  }\n  const status =\n    (\n      {\n        generating: "正在生成参数",\n        pending: "参数已生成",\n        running: "执行中",\n        queued: "排队中",\n        waiting_approval: "等待审批",\n        approval_required: "等待审批",\n        success: "已完成",\n        succeeded: "已完成",\n        completed: "已完成",\n        failed: "失败",\n        error: "失败",\n        cancelled: "已取消",\n      } as Record<string, string>\n    )[tool.status] ?? tool.status;\n  return (\n    <details className="message-tool" data-tool-status={tool.status}>\n      <summary>\n        <ChevronRight className="tool-chevron" size={14} />\n        <Wrench size={14} aria-hidden="true" />\n        <span className="tool-name" title={presentation?.detail}>\n          {presentation?.title ?? tool.name ?? "工具调用"}\n          {presentation?.detail ? ` · ${presentation.detail}` : ""}\n        </span>\n        <span className="tool-state">{status}</span>\n      </summary>\n      <div className="tool-details">\n        {tool.arguments && (\n          <>\n            <span className="tool-detail-label">参数</span>\n            <pre>{tool.arguments}</pre>\n          </>\n        )}\n        {tool.result !== undefined && (\n          <>\n            <span className="tool-detail-label">结果</span>\n            <pre>{tool.result || "无文本输出"}</pre>\n          </>\n        )}\n        {tool.truncated && <small>内容已截断</small>}\n      </div>\n    </details>\n  );\n}',
  ExecutionDialog:
    'export function ExecutionDialog({\n  client,\n  scope,\n  onClose,\n  onOpen,\n  embedded = false,\n  hideEmpty = false,\n}: {\n  client: WorkspaceClient;\n  scope: ExecutionScope;\n  onClose: () => void;\n  onOpen: (id: string) => void;\n  embedded?: boolean;\n  hideEmpty?: boolean;\n}) {\n  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n  useModal(dialog, undefined, !embedded);\n  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);\n  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];\n  const groups = executionThreadGroups(snapshot);\n  const grouped = !!snapshot?.threads && groups.length > 1;\n  const atReadLimit =\n    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;\n  const content = (\n    <>\n      {!embedded && (\n        <header>\n          <div>\n            <h2 id="execution-title">执行记录</h2>\n            <p className="muted">\n              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}\n              {snapshot?.limit ?? 100} 项执行\n            </p>\n          </div>\n          <button onClick={onClose} aria-label="关闭执行记录">\n            <X />\n          </button>\n        </header>\n      )}\n      {error && (\n        <p role="alert" className="delivery-error">\n          {error}\n        </p>\n      )}\n      {notice && (\n        <p role="status" className="execution-notice">\n          {notice}\n        </p>\n      )}\n      {(!embedded ||\n        error ||\n        !!snapshot?.jobs.length ||\n        !!snapshot?.approvals.length ||\n        snapshot?.threadsTruncated) && (\n        <div className="execution-dialog-toolbar">\n          <span className="muted">\n            {!!snapshot?.approvals.length && "单次授权"}\n          </span>\n          {embedded && atReadLimit && (\n            <small className="execution-history-bound">\n              当前为最近 {snapshot!.limit} 项执行\n            </small>\n          )}\n          {snapshot?.threadsTruncated && (\n            <small className="execution-history-bound">\n              部分子任务记录尚未载入\n            </small>\n          )}\n          <button aria-label="刷新执行记录" onClick={() => void refresh()}>\n            <RefreshCw />\n          </button>\n        </div>\n      )}\n      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}\n      <div className="execution-list">\n        {snapshot?.approvals.map((approval) => (\n          <section\n            className="execution-approval"\n            key={approval.request.approval_id}\n          >\n            <ApprovalDetails approval={approval} />\n            <div className="execution-actions">\n              <button\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "deny",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                拒绝\n              </button>\n              <button\n                className="primary"\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "allow-once",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                <Check />\n                仅允许这一次\n              </button>\n            </div>\n          </section>\n        ))}\n        {snapshot &&\n          !snapshot.jobs.length &&\n          !snapshot.approvals.length &&\n          !grouped && (\n            <p className="muted execution-empty">\n              {hideEmpty ? null : "暂无工具执行记录。"}\n            </p>\n          )}\n        {groups.map((group) => {\n          const status = group.thread\n            ? executionActivityStatus(group.thread, client.online && !error)\n            : undefined;\n          return (\n            <section\n              key={group.id}\n              className={grouped ? "execution-thread-group" : undefined}\n              data-execution-thread={group.thread?.id}\n              data-thread-depth={group.depth}\n              style={\n                grouped\n                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }\n                  : undefined\n              }\n            >\n              {grouped && group.thread && (\n                <header className="execution-thread-heading">\n                  <span\n                    className="execution-thread-state"\n                    data-status={status?.kind}\n                    title={status?.label}\n                  >\n                    <ExecutionStatusIcon kind={status?.kind} size={18} />\n                  </span>\n                  <div>\n                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>\n                    <strong title={group.thread.title}>\n                      {group.thread.title ||\n                        (group.depth > 0 ? "子任务" : "本次执行")}\n                    </strong>\n                  </div>\n                  <span className="execution-thread-status">\n                    {status?.label}\n                  </span>\n                </header>\n              )}\n              {grouped && group.thread?.summary && (\n                <p className="execution-thread-summary">\n                  {group.thread.summary}\n                </p>\n              )}\n              {grouped &&\n                group.depth > 0 &&\n                group.thread?.lifecycle === "open" && (\n                  <div className="execution-actions">\n                    <button\n                      disabled={!!busy || !!error || !client.online}\n                      onClick={() =>\n                        void control(\n                          {\n                            type: "cancel-thread",\n                            threadId: group.thread!.id,\n                            revision: group.thread!.revision,\n                          },\n                          group.thread!.id,\n                        )\n                      }\n                    >\n                      <Square />\n                      停止此子任务\n                    </button>\n                  </div>\n                )}\n              <div\n                className={grouped ? "execution-thread-timeline" : undefined}\n              >\n                {group.jobs.map((job) => {\n                  const presentation = executionJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {job.cancel_requested_at &&\n                          ["queued", "waiting_approval", "running"].includes(\n                            job.status,\n                          )\n                            ? "正在停止"\n                            : jobStatusLabel[job.status]}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                })}\n              </div>\n            </section>\n          );\n        })}\n      </div>\n    </>\n  );\n  return embedded ? (\n    <section className="execution-details" aria-label="工具执行与审批">\n      {content}\n    </section>\n  ) : (\n    <dialog\n      ref={dialog}\n      className="create-dialog library-dialog execution-dialog"\n      aria-labelledby="execution-title"\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      {content}\n    </dialog>\n  );\n}',
  liveBody:
    '  let presentation;\n  try {\n    presentation = executionPresentation(\n      tool.name,\n      JSON.parse(tool.arguments),\n      state,\n    );\n  } catch {\n    /* Streaming arguments may be incomplete. */\n  }\n  const status =\n    (\n      {\n        generating: "正在生成参数",\n        pending: "参数已生成",\n        running: "执行中",\n        queued: "排队中",\n        waiting_approval: "等待审批",\n        approval_required: "等待审批",\n        success: "已完成",\n        succeeded: "已完成",\n        completed: "已完成",\n        failed: "失败",\n        error: "失败",\n        cancelled: "已取消",\n      } as Record<string, string>\n    )[tool.status] ?? tool.status;\n',
  snapshotStatus:
    'job.cancel_requested_at &&\n                          ["queued", "waiting_approval", "running"].includes(\n                            job.status,\n                          )\n                            ? "正在停止"\n                            : jobStatusLabel[job.status]',
  jobRow:
    '(job) => {\n                  const presentation = executionJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {job.cancel_requested_at &&\n                          ["queued", "waiting_approval", "running"].includes(\n                            job.status,\n                          )\n                            ? "正在停止"\n                            : jobStatusLabel[job.status]}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                }',
} as const;

import React, { useEffect, useRef, useState } from "react";
// The isolated Node tsx loader uses classic JSX; Vite uses the automatic runtime.
void React;
import {
  ChevronRight,
  Wrench,
  X,
  RefreshCw,
  Square,
  Check,
  FileText,
} from "lucide-react";
import type { LiveMessage } from "../../packages/core/src/live-conversation.js";
import {
  jobStatusLabel,
  type ExecutionScope,
  type ExecutionControl,
} from "../../packages/core/src/execution.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import { useModal } from "../../apps/web/src/useModal.js";
import { useObservedRead } from "../../apps/web/src/useObservedRead.js";
import { executionThreadGroups } from "../../apps/web/src/execution-thread-groups.js";
import { executionActivityStatus } from "../../apps/web/src/execution-activity.js";
import { ExecutionStatusIcon } from "../../apps/web/src/ExecutionStatusIcon.js";
import { ApprovalDetails } from "../../apps/web/src/ApprovalCard.js";

/* FIXED_PURE_BEGIN */
import { isObjectToolName } from "../../packages/core/src/application-names.js";
import type { ExecutionSnapshot } from "../../packages/core/src/execution.js";
import type { Workspace } from "../../packages/core/src/model.js";
import {
  currentScriptDraft,
  scriptKindLabels,
} from "../../packages/core/src/script-studio.js";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
const short = (value: string) => value.replace(/\s+/g, " ").slice(0, 160);

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
) {
  const args = record(request);
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
        "submit-workflow": "提交创作结果",
        "read-results": "查看创作结果",
        "read-result": "读取创作结果",
        issues: "检查剧本",
        impact: "分析改动影响",
        "create-production": "新建剧本",
        "create-item": `新建${kind}`,
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
  };
  const nouns: Record<string, string> = {
    projects: "项目",
    conversations: "会话",
    bookmarks: "浏览器收藏",
    directory: "目录",
    "local-file": "本地文件",
    browser: "浏览器",
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
  };
  const nested = record(
    args.management ??
      args.bookmarks ??
      args.directory ??
      args.localFile ??
      args.browser,
  );
  const title =
    labels[action] ??
    (nouns[action]
      ? `${verbs[text(nested.action)] ?? "操作"}${nouns[action]}`
      : `工作对象 · ${action || "操作"}`);
  const artifact = state.artifacts.find(
    (a) => a.id === (args.artifactId ?? args.taskId ?? record(args.content).id),
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
    text(args.query ?? args.path ?? nested.path);
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

/* FIXED_PURE_END */
/* FIXED_TOOL_BEGIN */
export function FixedToolMessage({
  message,
  state,
}: {
  message: LiveMessage;
  state: Workspace;
}) {
  const tool = message.tool!;
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
  return (
    <details className="message-tool" data-tool-status={tool.status}>
      <summary>
        <ChevronRight className="tool-chevron" size={14} />
        <Wrench size={14} aria-hidden="true" />
        <span className="tool-name" title={presentation?.detail}>
          {presentation?.title ?? tool.name ?? "工具调用"}
          {presentation?.detail ? ` · ${presentation.detail}` : ""}
        </span>
        <span className="tool-state">{status}</span>
      </summary>
      <div className="tool-details">
        {tool.arguments && (
          <>
            <span className="tool-detail-label">参数</span>
            <pre>{tool.arguments}</pre>
          </>
        )}
        {tool.result !== undefined && (
          <>
            <span className="tool-detail-label">结果</span>
            <pre>{tool.result || "无文本输出"}</pre>
          </>
        )}
        {tool.truncated && <small>内容已截断</small>}
      </div>
    </details>
  );
}
/* FIXED_TOOL_END */
/* FIXED_DIALOG_BEGIN */
export function FixedExecutionDialog({
  client,
  scope,
  onClose,
  onOpen,
  embedded = false,
  hideEmpty = false,
}: {
  client: WorkspaceClient;
  scope: ExecutionScope;
  onClose: () => void;
  onOpen: (id: string) => void;
  embedded?: boolean;
  hideEmpty?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    api = useRef(client),
    mounted = useRef(true);
  api.current = client;
  const [observation, setObservation] = useState<{
      scope: string;
      snapshot: ExecutionSnapshot;
    } | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState("");
  const [result, setResult] = useState<{
    id: string;
    text: string;
    truncated: boolean;
    available: boolean;
  } | null>(null);
  const observationScope = JSON.stringify([
    client.boot?.centerId,
    client.boot?.principalId,
    client.boot?.csrfToken,
    scope,
  ]);
  const currentScope = useRef(observationScope);
  currentScope.current = observationScope;
  const snapshot =
    observation?.scope === observationScope ? observation.snapshot : null;
  const refresh = useObservedRead({
    scope: observationScope,
    enabled: client.online,
    revision: client.workspaceChangeRevision,
    read: (signal) => api.current.executionSnapshot(scope, signal),
    publish: (next) => {
      setObservation({ scope: observationScope, snapshot: next });
      setError("");
    },
    failed: (cause) =>
      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),
  });
  useModal(dialog, undefined, !embedded);
  useEffect(() => {
    mounted.current = true;

    setObservation(null);
    setResult(null);
    setError("");
    setBusy("");
    setNotice("");
    return () => {
      mounted.current = false;
    };
  }, [observationScope]);
  async function control(
    action: ExecutionControl["action"],
    threadId?: string,
  ) {
    const origin = observationScope;
    const current = () => mounted.current && currentScope.current === origin;
    setBusy(
      action.type === "cancel-job"
        ? action.jobId
        : action.type === "cancel-thread"
          ? action.threadId
          : action.approvalId,
    );
    setNotice("");
    try {
      await api.current.controlExecution({
        scope: threadId ? { ...scope, threadId } : scope,
        action,
      });
      if (current())
        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");
    } catch (error) {
      if (current())
        setNotice(
          error instanceof Error
            ? error.message
            : "结果未确认，请核对最新状态。",
        );
    } finally {
      if (current()) {
        setBusy("");
        void refresh();
      }
    }
  }
  async function readResult(id: string) {
    const origin = observationScope;
    const current = () => mounted.current && currentScope.current === origin;
    setBusy(id);
    try {
      const value = await api.current.executionResult(scope, id);
      if (current()) setResult({ id, ...value });
    } catch (error) {
      if (current())
        setNotice(error instanceof Error ? error.message : "无法读取结果。");
    } finally {
      if (current()) setBusy("");
    }
  }
  let producedId: string | undefined;
  if (result) {
    try {
      const data = JSON.parse(result.text);
      if (
        data.ok === true &&
        typeof data.artifactId === "string" &&
        (client.boot?.workspace.artifacts.some(
          (a) => a.id === data.artifactId && a.projectId === scope.projectId,
        ) ||
          client.contentCatalog.some(
            (entry) =>
              entry.id === data.artifactId &&
              entry.projectId === scope.projectId,
          ))
      )
        producedId = data.artifactId;
    } catch {
      /* Ordinary tool output need not be JSON. */
    }
  }
  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);
  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];
  const groups = executionThreadGroups(snapshot);
  const grouped = !!snapshot?.threads && groups.length > 1;
  const atReadLimit =
    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;
  const content = (
    <>
      {!embedded && (
        <header>
          <div>
            <h2 id="execution-title">执行记录</h2>
            <p className="muted">
              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}
              {snapshot?.limit ?? 100} 项执行
            </p>
          </div>
          <button onClick={onClose} aria-label="关闭执行记录">
            <X />
          </button>
        </header>
      )}
      {error && (
        <p role="alert" className="delivery-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="execution-notice">
          {notice}
        </p>
      )}
      {(!embedded ||
        error ||
        !!snapshot?.jobs.length ||
        !!snapshot?.approvals.length ||
        snapshot?.threadsTruncated) && (
        <div className="execution-dialog-toolbar">
          <span className="muted">
            {!!snapshot?.approvals.length && "单次授权"}
          </span>
          {embedded && atReadLimit && (
            <small className="execution-history-bound">
              当前为最近 {snapshot!.limit} 项执行
            </small>
          )}
          {snapshot?.threadsTruncated && (
            <small className="execution-history-bound">
              部分子任务记录尚未载入
            </small>
          )}
          <button aria-label="刷新执行记录" onClick={() => void refresh()}>
            <RefreshCw />
          </button>
        </div>
      )}
      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}
      <div className="execution-list">
        {snapshot?.approvals.map((approval) => (
          <section
            className="execution-approval"
            key={approval.request.approval_id}
          >
            <ApprovalDetails approval={approval} />
            <div className="execution-actions">
              <button
                disabled={
                  !!busy ||
                  !!error ||
                  !client.online ||
                  client.approvalSubmitted(
                    approval.request.approval_id,
                    approval.fingerprint,
                  )
                }
                onClick={() =>
                  void control(
                    {
                      type: "deny",
                      approvalId: approval.request.approval_id,
                      fingerprint: approval.fingerprint,
                    },
                    grouped ? approval.request.thread_id : undefined,
                  )
                }
              >
                拒绝
              </button>
              <button
                className="primary"
                disabled={
                  !!busy ||
                  !!error ||
                  !client.online ||
                  client.approvalSubmitted(
                    approval.request.approval_id,
                    approval.fingerprint,
                  )
                }
                onClick={() =>
                  void control(
                    {
                      type: "allow-once",
                      approvalId: approval.request.approval_id,
                      fingerprint: approval.fingerprint,
                    },
                    grouped ? approval.request.thread_id : undefined,
                  )
                }
              >
                <Check />
                仅允许这一次
              </button>
            </div>
          </section>
        ))}
        {snapshot &&
          !snapshot.jobs.length &&
          !snapshot.approvals.length &&
          !grouped && (
            <p className="muted execution-empty">
              {hideEmpty ? null : "暂无工具执行记录。"}
            </p>
          )}
        {groups.map((group) => {
          const status = group.thread
            ? executionActivityStatus(group.thread, client.online && !error)
            : undefined;
          return (
            <section
              key={group.id}
              className={grouped ? "execution-thread-group" : undefined}
              data-execution-thread={group.thread?.id}
              data-thread-depth={group.depth}
              style={
                grouped
                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }
                  : undefined
              }
            >
              {grouped && group.thread && (
                <header className="execution-thread-heading">
                  <span
                    className="execution-thread-state"
                    data-status={status?.kind}
                    title={status?.label}
                  >
                    <ExecutionStatusIcon kind={status?.kind} size={18} />
                  </span>
                  <div>
                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>
                    <strong title={group.thread.title}>
                      {group.thread.title ||
                        (group.depth > 0 ? "子任务" : "本次执行")}
                    </strong>
                  </div>
                  <span className="execution-thread-status">
                    {status?.label}
                  </span>
                </header>
              )}
              {grouped && group.thread?.summary && (
                <p className="execution-thread-summary">
                  {group.thread.summary}
                </p>
              )}
              {grouped &&
                group.depth > 0 &&
                group.thread?.lifecycle === "open" && (
                  <div className="execution-actions">
                    <button
                      disabled={!!busy || !!error || !client.online}
                      onClick={() =>
                        void control(
                          {
                            type: "cancel-thread",
                            threadId: group.thread!.id,
                            revision: group.thread!.revision,
                          },
                          group.thread!.id,
                        )
                      }
                    >
                      <Square />
                      停止此子任务
                    </button>
                  </div>
                )}
              <div
                className={grouped ? "execution-thread-timeline" : undefined}
              >
                {group.jobs.map((job) => {
                  const presentation = executionJobPresentation(
                    job,
                    client.boot!.workspace,
                  );
                  return (
                    <section
                      key={job.id}
                      className="execution-job"
                      data-job-id={job.id}
                    >
                      <header>
                        <strong title={presentation.title}>
                          {presentation.title}
                        </strong>
                        <span className={`job-status ${job.status}`}>
                          {job.cancel_requested_at &&
                          ["queued", "waiting_approval", "running"].includes(
                            job.status,
                          )
                            ? "正在停止"
                            : jobStatusLabel[job.status]}
                        </span>
                      </header>
                      {presentation.detail && (
                        <p className="execution-object">
                          {presentation.detail}
                        </p>
                      )}
                      <small className="muted">
                        {!grouped && branchIds.length > 1 && (
                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>
                        )}
                        {new Date(job.created_at).toLocaleString("zh-CN")}
                      </small>
                      {job.error && (
                        <p className="delivery-error">{job.error}</p>
                      )}
                      {presentation.result && (
                        <p
                          className="execution-step-result"
                          aria-label="返回结果解读"
                          title={presentation.result}
                        >
                          {presentation.result}
                        </p>
                      )}
                      <details>
                        <summary>技术详情</summary>
                        <pre>{JSON.stringify(job.request, null, 2)}</pre>
                        <small>执行节点：{job.target_id} · </small>
                        <small>执行 ID：{job.id}</small>
                      </details>
                      <div className="execution-actions">
                        {job.result_event_id && (
                          <button
                            disabled={!!busy}
                            onClick={() => void readResult(job.id)}
                          >
                            查看结果
                          </button>
                        )}
                        {["queued", "waiting_approval", "running"].includes(
                          job.status,
                        ) && (
                          <button
                            disabled={
                              !!busy || !!error || !!job.cancel_requested_at
                            }
                            onClick={() =>
                              void control(
                                {
                                  type: "cancel-job",
                                  jobId: job.id,
                                  revision: job.revision,
                                },
                                grouped ? job.thread_id : undefined,
                              )
                            }
                          >
                            <Square />
                            停止此项执行
                          </button>
                        )}
                        {job.exit_code !== null && (
                          <small className="muted">
                            退出码 {job.exit_code}
                          </small>
                        )}
                      </div>
                      {result?.id === job.id && (
                        <div className="execution-result">
                          {executionResultSummary(result.text) && (
                            <p>{executionResultSummary(result.text)}</p>
                          )}
                          {producedId && (
                            <button
                              onClick={() => {
                                onOpen(producedId!);
                                onClose();
                              }}
                            >
                              <FileText />
                              {client.boot?.workspace.artifacts.find(
                                (a) => a.id === producedId,
                              )?.title ??
                                client.contentCatalog.find(
                                  (entry) => entry.id === producedId,
                                )?.title ??
                                "打开成果"}
                            </button>
                          )}
                          <details>
                            <summary>完整返回内容</summary>
                            <pre>
                              {result.available
                                ? result.text || "执行返回了空内容。"
                                : "尚无最终结果。"}
                            </pre>
                          </details>
                          {result.truncated && (
                            <small>结果较长，当前显示前 64,000 个字符。</small>
                          )}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
  return embedded ? (
    <section className="execution-details" aria-label="工具执行与审批">
      {content}
    </section>
  ) : (
    <dialog
      ref={dialog}
      className="create-dialog library-dialog execution-dialog"
      aria-labelledby="execution-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {content}
    </dialog>
  );
}
/* FIXED_DIALOG_END */

// Finite pure adapters of the original component's complete render projection.
// The original complete JSX remains executable above; no candidate builds this oracle.
export function fixedLiveToolPresentation(
  tool: NonNullable<LiveMessage["tool"]>,
  state: Workspace,
) {
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
export function fixedSnapshotJobPresentation(
  job: ExecutionSnapshot["jobs"][number],
  state: Workspace,
) {
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
