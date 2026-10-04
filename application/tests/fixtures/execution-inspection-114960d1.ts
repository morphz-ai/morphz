// Independent actual Git 114960d1cd1529082751efb424f0a7d8584bd721; finite complete lifecycle, registration and provenance archive.
// No current whole Dialog/App/Client hash or inverse chain is a CI contract.
export const executionInspectionOriginal = {
  git: "114960d1cd1529082751efb424f0a7d8584bd721",
  provenance: {
    Dialog: {
      path: "application/apps/web/src/ExecutionDialog.tsx",
      bytes: 17475,
      sha256:
        "048da989bf6e725086ba88effd295bd492d85be934cb43c93e6f179a0122a406",
    },
    Observed: {
      path: "application/apps/web/src/useObservedRead.ts",
      bytes: 2020,
      sha256:
        "cf3ff430ad1de70fe2a76ff8e64d77b40a23ac124212a41e85880c7e19cc3517",
    },
    Modal: {
      path: "application/apps/web/src/useModal.ts",
      bytes: 5140,
      sha256:
        "f9f45b71766ac08a3ae47ff3a5b4300a61193f2fef17e76f99ab63924781cac4",
    },
    CoreInteraction: {
      path: "application/apps/web/src/data/execution-interactions.ts",
      bytes: 3239,
      sha256:
        "529e6333ea1a8cd402f8c47bb7206bf384f3d369c8157f193436d15d3ebb9499",
    },
  },
  spans: {
    refs: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1079,
      end: 1180,
      raw: "const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);",
      bytes: 101,
      sha256:
        "2cc88d2820b9064ad163626a6f88a9ca3003c687e8fa69737dda9857850820fb",
    },
    publishApi: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1183,
      end: 1204,
      raw: "api.current = client;",
      bytes: 21,
      sha256:
        "7beaae66965cd2e1698d8ea66c0a38cc895998afbc8eca046256d15efcfe36a8",
    },
    feedbackStates: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1207,
      end: 1446,
      raw: 'const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");',
      bytes: 239,
      sha256:
        "7360dcd7c93588c11b8f48eacbf3a9862adc7530ca2b70193997a686d78fd6b6",
    },
    resultState: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1449,
      end: 1588,
      raw: "const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);",
      bytes: 139,
      sha256:
        "9e9db903a396f825acd0a5f417ed20e9c789da1f303d227caf24116ec9b78e14",
    },
    observationScope: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1591,
      end: 1734,
      raw: "const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);",
      bytes: 143,
      sha256:
        "5357c9b53da188d383ea79ef384060e155fc8dfc8e0575778c701176fdbe38f5",
    },
    currentScope: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1737,
      end: 1783,
      raw: "const currentScope = useRef(observationScope);",
      bytes: 46,
      sha256:
        "88f2053ee98b040797c02034830801f5903003770832c3d694f96cc07bc99cc5",
    },
    publishScope: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1786,
      end: 1826,
      raw: "currentScope.current = observationScope;",
      bytes: 40,
      sha256:
        "14c8f7df23bcc3be1f253dde671d96b84c78b9dd0b4d1feb0043367bc11cd412",
    },
    snapshot: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1829,
      end: 1920,
      raw: "const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;",
      bytes: 91,
      sha256:
        "bef0a7244248282b3f83d0773f48876f85d6748509cdb25bd016fecb25291032",
    },
    observation: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1923,
      end: 2345,
      raw: 'const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });',
      bytes: 440,
      sha256:
        "f8eb69210250c6584011110499bb7f55d3a31982271866a5c80e3989e9e40844",
    },
    modal: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 2348,
      end: 2387,
      raw: "useModal(dialog, undefined, !embedded);",
      bytes: 39,
      sha256:
        "69e082a054472d88343e718783b17a6944e4b9ff9c39fd61bd0152234be900ba",
    },
    retirement: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 2390,
      end: 2620,
      raw: 'useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);',
      bytes: 230,
      sha256:
        "2f3c3b6974a55a9a7bac7a627509b958bfbff1cac052e2e39c0fd87e41f17010",
    },
    control: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 2623,
      end: 3523,
      raw: 'async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }',
      bytes: 948,
      sha256:
        "f306223470dc933bfecab983fa8fea83308b5cc531082d84525bed7f42cc6c8d",
    },
    readResult: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 3526,
      end: 3997,
      raw: 'async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }',
      bytes: 485,
      sha256:
        "d2bd7b4eb90be4ed8cd25d8c391ca7143b68403bb024af483c88846e3f559298",
    },
    producedDeclaration: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 4000,
      end: 4035,
      raw: "let producedId: string | undefined;",
      bytes: 35,
      sha256:
        "4bd3f45db73bb0f597ee3f382367fec7fcc55b2ff130462ced52c827e82c2408",
    },
    producedProjection: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 4038,
      end: 4622,
      raw: 'if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }',
      bytes: 584,
      sha256:
        "de9c921f4118b4558e30c88c14b5519562fdb2d5c316b7b9036ce1075966aaa6",
    },
    dialogDeclaration: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 1085,
      end: 1125,
      raw: "dialog = useRef<HTMLDialogElement>(null)",
      bytes: 40,
      sha256:
        "014b921b7bdfecdb9580e51bf587fa509e94cef33e84187a439e0e3a3bd0c31e",
    },
    componentSignature: {
      file: "application/apps/web/src/ExecutionDialog.tsx",
      start: 832,
      end: 1073,
      raw: "{\n  client,\n  scope,\n  onClose,\n  onOpen,\n  embedded = false,\n  hideEmpty = false,\n}: {\n  client: WorkspaceClient;\n  scope: ExecutionScope;\n  onClose: () => void;\n  onOpen: (id: string) => void;\n  embedded?: boolean;\n  hideEmpty?: boolean;\n}",
      bytes: 241,
      sha256:
        "d3f69c8bcfde84b4c5648e0d609cd69cda3b88350e7ecaadc38e2843fd39042a",
    },
  },
  originalComponent: {
    file: "application/apps/web/src/ExecutionDialog.tsx",
    start: 800,
    end: 17037,
    raw: 'export function ExecutionDialog({\n  client,\n  scope,\n  onClose,\n  onOpen,\n  embedded = false,\n  hideEmpty = false,\n}: {\n  client: WorkspaceClient;\n  scope: ExecutionScope;\n  onClose: () => void;\n  onOpen: (id: string) => void;\n  embedded?: boolean;\n  hideEmpty?: boolean;\n}) {\n  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n  useModal(dialog, undefined, !embedded);\n  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);\n  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];\n  const groups = executionThreadGroups(snapshot);\n  const grouped = !!snapshot?.threads && groups.length > 1;\n  const atReadLimit =\n    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;\n  const content = (\n    <>\n      {!embedded && (\n        <header>\n          <div>\n            <h2 id="execution-title">执行记录</h2>\n            <p className="muted">\n              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}\n              {snapshot?.limit ?? 100} 项执行\n            </p>\n          </div>\n          <button onClick={onClose} aria-label="关闭执行记录">\n            <X />\n          </button>\n        </header>\n      )}\n      {error && (\n        <p role="alert" className="delivery-error">\n          {error}\n        </p>\n      )}\n      {notice && (\n        <p role="status" className="execution-notice">\n          {notice}\n        </p>\n      )}\n      {(!embedded ||\n        error ||\n        !!snapshot?.jobs.length ||\n        !!snapshot?.approvals.length ||\n        snapshot?.threadsTruncated) && (\n        <div className="execution-dialog-toolbar">\n          <span className="muted">\n            {!!snapshot?.approvals.length && "单次授权"}\n          </span>\n          {embedded && atReadLimit && (\n            <small className="execution-history-bound">\n              当前为最近 {snapshot!.limit} 项执行\n            </small>\n          )}\n          {snapshot?.threadsTruncated && (\n            <small className="execution-history-bound">\n              部分子任务记录尚未载入\n            </small>\n          )}\n          <button aria-label="刷新执行记录" onClick={() => void refresh()}>\n            <RefreshCw />\n          </button>\n        </div>\n      )}\n      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}\n      <div className="execution-list">\n        {snapshot?.approvals.map((approval) => (\n          <section\n            className="execution-approval"\n            key={approval.request.approval_id}\n          >\n            <ApprovalDetails approval={approval} />\n            <div className="execution-actions">\n              <button\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "deny",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                拒绝\n              </button>\n              <button\n                className="primary"\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "allow-once",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                <Check />\n                仅允许这一次\n              </button>\n            </div>\n          </section>\n        ))}\n        {snapshot &&\n          !snapshot.jobs.length &&\n          !snapshot.approvals.length &&\n          !grouped && (\n            <p className="muted execution-empty">\n              {hideEmpty ? null : "暂无工具执行记录。"}\n            </p>\n          )}\n        {groups.map((group) => {\n          const status = group.thread\n            ? executionActivityStatus(group.thread, client.online && !error)\n            : undefined;\n          return (\n            <section\n              key={group.id}\n              className={grouped ? "execution-thread-group" : undefined}\n              data-execution-thread={group.thread?.id}\n              data-thread-depth={group.depth}\n              style={\n                grouped\n                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }\n                  : undefined\n              }\n            >\n              {grouped && group.thread && (\n                <header className="execution-thread-heading">\n                  <span\n                    className="execution-thread-state"\n                    data-status={status?.kind}\n                    title={status?.label}\n                  >\n                    <ExecutionStatusIcon kind={status?.kind} size={18} />\n                  </span>\n                  <div>\n                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>\n                    <strong title={group.thread.title}>\n                      {group.thread.title ||\n                        (group.depth > 0 ? "子任务" : "本次执行")}\n                    </strong>\n                  </div>\n                  <span className="execution-thread-status">\n                    {status?.label}\n                  </span>\n                </header>\n              )}\n              {grouped && group.thread?.summary && (\n                <p className="execution-thread-summary">\n                  {group.thread.summary}\n                </p>\n              )}\n              {grouped &&\n                group.depth > 0 &&\n                group.thread?.lifecycle === "open" && (\n                  <div className="execution-actions">\n                    <button\n                      disabled={!!busy || !!error || !client.online}\n                      onClick={() =>\n                        void control(\n                          {\n                            type: "cancel-thread",\n                            threadId: group.thread!.id,\n                            revision: group.thread!.revision,\n                          },\n                          group.thread!.id,\n                        )\n                      }\n                    >\n                      <Square />\n                      停止此子任务\n                    </button>\n                  </div>\n                )}\n              <div\n                className={grouped ? "execution-thread-timeline" : undefined}\n              >\n                {group.jobs.map((job) => {\n                  const presentation = executionSnapshotJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {presentation.statusLabel}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                })}\n              </div>\n            </section>\n          );\n        })}\n      </div>\n    </>\n  );\n  return embedded ? (\n    <section className="execution-details" aria-label="工具执行与审批">\n      {content}\n    </section>\n  ) : (\n    <dialog\n      ref={dialog}\n      className="create-dialog library-dialog execution-dialog"\n      aria-labelledby="execution-title"\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      {content}\n    </dialog>\n  );\n}',
    bytes: 16674,
    sha256: "faaefd4e3d90ad89d32d241a6d04bdd1479a6e18e66e5cbc2b8db735e7ae695c",
  },
  registrations: {
    direct: [
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1094,
        end: 1125,
        raw: "useRef<HTMLDialogElement>(null)",
        bytes: 31,
        sha256:
          "7c8c89e85b80afd38f0c9e74bcbdb73f81b4f087121d9c75eee1549ba23f5861",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1137,
        end: 1151,
        raw: "useRef(client)",
        bytes: 14,
        sha256:
          "a9a4771cb94b62833cb07125b389f360f4dd3fad880da09dffbf7132183a59cc",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1167,
        end: 1179,
        raw: "useRef(true)",
        bytes: 12,
        sha256:
          "507225c7de4c5c43117ed725c564c70de922d6c140692c3a24cb03a4a7f0f2f2",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1245,
        end: 1331,
        raw: "useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null)",
        bytes: 86,
        sha256:
          "0b9b9f8a3520616c76548ffb95a950ccf65570ad0adeebc8d619824654c09c42",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1357,
        end: 1369,
        raw: 'useState("")',
        bytes: 12,
        sha256:
          "f36034ffb183df946688fd4c4b6a3fd73a800cbd7999b4f762eac158a6af4d5d",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1393,
        end: 1405,
        raw: 'useState("")',
        bytes: 12,
        sha256:
          "f36034ffb183df946688fd4c4b6a3fd73a800cbd7999b4f762eac158a6af4d5d",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1433,
        end: 1445,
        raw: 'useState("")',
        bytes: 12,
        sha256:
          "f36034ffb183df946688fd4c4b6a3fd73a800cbd7999b4f762eac158a6af4d5d",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1477,
        end: 1587,
        raw: "useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null)",
        bytes: 110,
        sha256:
          "75c62884f8b412ccccdf38987d3fe20667693e0701d0623342791753fedf833e",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 1758,
        end: 1782,
        raw: "useRef(observationScope)",
        bytes: 24,
        sha256:
          "c40e6eda14617f7e35cb7ba5a1a491d6ac62ab789e3438be707af72c541bbedc",
      },
      {
        file: "application/apps/web/src/ExecutionDialog.tsx",
        start: 2390,
        end: 2619,
        raw: 'useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope])',
        bytes: 229,
        sha256:
          "751ec11fdeef1a94d12bb3e11788e5a70583248612a797c499554ee0ae9bf976",
      },
    ],
    observed: [
      {
        file: "application/apps/web/src/useObservedRead.ts",
        start: 580,
        end: 595,
        raw: "useRef(options)",
        bytes: 15,
        sha256:
          "a5bf64afbe78e34e265a3cd20511cf403ae344371339ca7c899d1f2be1d1f8cc",
      },
      {
        file: "application/apps/web/src/useObservedRead.ts",
        start: 644,
        end: 724,
        raw: "useRef<ReturnType<typeof createObservedRead<T>> | undefined>(\n    undefined,\n  )",
        bytes: 80,
        sha256:
          "c9ff4670e1dbc8ced6a6b072438e138fdac1421a2ceeaa6ed066bec2e637d309",
      },
      {
        file: "application/apps/web/src/useObservedRead.ts",
        start: 745,
        end: 769,
        raw: "useRef(options.revision)",
        bytes: 24,
        sha256:
          "e4b47bba6c04ca076b968e47d5dc9a3228dcf5428d247cb398452e39a4d04095",
      },
      {
        file: "application/apps/web/src/useObservedRead.ts",
        start: 773,
        end: 1750,
        raw: 'useEffect(() => {\n    revision.current = latest.current.revision;\n    if (!options.enabled) return;\n    const currentScope = () =>\n      latest.current.scope === options.scope && latest.current.enabled;\n    const current = createObservedRead({\n      read: (signal) => {\n        if (!currentScope())\n          throw new DOMException("读取范围已变化。", "AbortError");\n        return latest.current.read(signal);\n      },\n      // The render updates latest before passive cleanup. A response that\n      // settles in that gap must not be published under the new scope.\n      publish: (value: T) => {\n        if (currentScope()) latest.current.publish(value);\n      },\n      failed: (error) => {\n        if (currentScope()) latest.current.failed(error);\n      },\n    });\n    observer.current = current;\n    void current.request();\n    return () => {\n      current.close();\n      if (observer.current === current) observer.current = undefined;\n    };\n  }, [options.scope, options.enabled])',
        bytes: 993,
        sha256:
          "cc8742d6a847cb279bee45db2041f610d65530b7364096563bc80c9e0bda0597",
      },
      {
        file: "application/apps/web/src/useObservedRead.ts",
        start: 1754,
        end: 1930,
        raw: "useEffect(() => {\n    if (revision.current === options.revision) return;\n    revision.current = options.revision;\n    void observer.current?.request();\n  }, [options.revision])",
        bytes: 176,
        sha256:
          "6007b5be79f95ba39259f2988777621a7d80a6842d52c9128b70b6fe31c137f1",
      },
    ],
    modal: [
      {
        file: "application/apps/web/src/useModal.ts",
        start: 375,
        end: 396,
        raw: "useRef(fallbackFocus)",
        bytes: 21,
        sha256:
          "22218f41150d1379f49747362f84ff01ff46b02a0eb845ad6a3f22ddbc7fc540",
      },
      {
        file: "application/apps/web/src/useModal.ts",
        start: 436,
        end: 5136,
        raw: 'useLayoutEffect(() => {\n    const origin = document.activeElement as HTMLElement | null;\n    const textOrigin =\n      origin instanceof HTMLInputElement ||\n      origin instanceof HTMLTextAreaElement\n        ? origin\n        : null;\n    const textSelection =\n      textOrigin && textOrigin.selectionStart !== null\n        ? ([\n            textOrigin.selectionStart,\n            textOrigin.selectionEnd ?? textOrigin.selectionStart,\n          ] as const)\n        : null;\n    const selection = window.getSelection();\n    const ranges = selection\n      ? Array.from({ length: selection.rangeCount }, (_, i) =>\n          selection.getRangeAt(i).cloneRange(),\n        )\n      : [];\n    const element = dialog.current;\n    if (!element || !open) return;\n    const main = document.querySelector<HTMLElement>(".workspace");\n    const position = () => {\n      const bounds = main?.getBoundingClientRect();\n      if (!bounds || bounds.width < 1) return;\n      // DOMRect is already rendered through CSS zoom. The dialog\'s fixed\n      // offsets and dimensions are layout CSS pixels; applying the rendered\n      // coordinates directly would scale them a second time.\n      const nativeZoom = (element as HTMLElement & { currentCSSZoom?: number })\n        .currentCSSZoom;\n      let zoom = nativeZoom ?? 1;\n      if (nativeZoom === undefined) {\n        for (\n          let ancestor: HTMLElement | null = element;\n          ancestor;\n          ancestor = ancestor.parentElement\n        ) {\n          const value = getComputedStyle(ancestor).zoom;\n          const factor = value.endsWith("%")\n            ? Number.parseFloat(value) / 100\n            : Number.parseFloat(value);\n          if (Number.isFinite(factor) && factor > 0) zoom *= factor;\n        }\n      }\n      if (!Number.isFinite(zoom) || zoom <= 0) zoom = 1;\n      element.style.setProperty(\n        "--modal-center",\n        `${(bounds.x + bounds.width / 2) / zoom}px`,\n      );\n      element.style.setProperty(\n        "--modal-max-width",\n        `${Math.max(0, bounds.width / zoom - 32)}px`,\n      );\n      element.style.setProperty(\n        "--modal-max-height",\n        `${Math.max(0, window.innerHeight / zoom - 32)}px`,\n      );\n    };\n    const observer = new ResizeObserver(position);\n    if (main) observer.observe(main);\n    window.addEventListener("resize", position);\n    position();\n    element.showModal();\n    // Chromium can move Tab from the last native-dialog control to browser\n    // chrome (and leave activeElement on body). Keep this task\'s keyboard loop\n    // explicit, including compact headers/footers whose DOM order has changed.\n    const keepFocus = (event: KeyboardEvent) => {\n      if (event.key !== "Tab" || event.defaultPrevented) return;\n      const controls = [\n        ...element.querySelectorAll<HTMLElement>(\n          "a[href],button,input,select,textarea,summary,[tabindex],[contenteditable=true]",\n        ),\n      ].filter(\n        (control) =>\n          control.tabIndex >= 0 &&\n          !control.matches(":disabled") &&\n          !control.closest("[inert]") &&\n          control.getClientRects().length > 0 &&\n          getComputedStyle(control).visibility !== "hidden",\n      );\n      const first = controls[0],\n        last = controls.at(-1);\n      if (\n        !first ||\n        (event.shiftKey\n          ? document.activeElement === first\n          : document.activeElement === last)\n      ) {\n        event.preventDefault();\n        (event.shiftKey ? last : first)?.focus();\n      }\n    };\n    element.addEventListener("keydown", keepFocus);\n    (\n      initialFocus?.current ??\n      element.querySelector<HTMLElement>("[autofocus]") ??\n      element.querySelector<HTMLElement>("input, textarea, select") ??\n      element.querySelector<HTMLElement>("button")\n    )?.focus();\n    return () => {\n      observer.disconnect();\n      element.removeEventListener("keydown", keepFocus);\n      window.removeEventListener("resize", position);\n      element.close();\n      if (origin?.isConnected && !document.querySelector("dialog[open]")) {\n        const returnTarget = origin.getClientRects().length\n          ? origin\n          : (origin.closest("details")?.querySelector<HTMLElement>("summary") ??\n            fallback.current?.(origin));\n        returnTarget?.focus({ preventScroll: true });\n        if (textOrigin && textSelection)\n          textOrigin.setSelectionRange(...textSelection);\n        else if (\n          ranges.every(\n            (r) => r.startContainer.isConnected && r.endContainer.isConnected,\n          )\n        ) {\n          selection?.removeAllRanges();\n          for (const range of ranges) selection?.addRange(range);\n        }\n      }\n    };\n  }, [dialog, initialFocus, open])',
        bytes: 4700,
        sha256:
          "4b79dd16d5802128f86ce2f64024a462a062140639d22115a2beb5dd9be76fe0",
      },
    ],
  },
} as const;
