// Independent actual committed Git 114960d1, never generated from candidate.
// Historical whole-source proof runs only from /tmp; CI needs no Git.
export const fixedInspectionMetadata = {
  git: "114960d1cd1529082751efb424f0a7d8584bd721",
  sources: {
    "ExecutionDialog.tsx": {
      bytes: 17475,
      sha256:
        "048da989bf6e725086ba88effd295bd492d85be934cb43c93e6f179a0122a406",
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
    "execution-presentation.ts": {
      bytes: 10446,
      sha256:
        "5332d826ec8074d6f186d7abcbe1525d521033a6c88e306fe1a43c5267ca3216",
    },
    "execution-thread-groups.ts": {
      bytes: 2387,
      sha256:
        "92e0dec6ca37212513187e8435d38dadd48c3315cc5c07e34bcfa15f0e9661d8",
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
    ExecutionDialog: {
      bytes: 16674,
      sha256:
        "faaefd4e3d90ad89d32d241a6d04bdd1479a6e18e66e5cbc2b8db735e7ae695c",
    },
    lifecycle: {
      bytes: 3626,
      sha256:
        "8029d96e984b123510484ab22de3d24e1c3dd8640a46bbc6b69befb81d3d04f5",
    },
    refsAndState: {
      bytes: 512,
      sha256:
        "99fee2b9488c2c81793bf7b6dc11b9e22687b6a61c36f99c2616d26de722d524",
    },
    scopeProjection: {
      bytes: 332,
      sha256:
        "c0bb29dccb70e6eece9d36df9ba9c93163f78a1963982fc063ed0e46b658fae2",
    },
    observation: {
      bytes: 443,
      sha256:
        "031972aea3336b559376e6119b6a0c336545aa971329e72f5dc3f203e32b60fd",
    },
    modal: {
      bytes: 42,
      sha256:
        "c9ef3dc1f7d2b1c029670dc55f96eaab5861bdf3103f0c760167d99ec1a812e6",
    },
    retirement: {
      bytes: 233,
      sha256:
        "b087bec722249e5c41c62f9af9053e9276020f24268a68348113e4f2b06ca66f",
    },
    control: {
      bytes: 951,
      sha256:
        "af5fdaf439132b0bbef45cfd01e0879aa15e26f827b100cdf879db2da69f240f",
    },
    readResult: {
      bytes: 488,
      sha256:
        "3b00a97294d3287290939aa27759b1e138c1e7101158e72fa4f3dbb92770ed8f",
    },
    producedId: {
      bytes: 625,
      sha256:
        "0ea1b6e39a2fbc5d44250b94ce15b5b3d4ed6515bfaf7307d84749923521bba5",
    },
    renderTail: {
      bytes: 12771,
      sha256:
        "24b97b1ad7a579cd39730e29300b5042f85f2e96cf9cffb617f7cab58511ab95",
    },
    rendererRefPrefix: {
      bytes: 104,
      sha256:
        "bc090d1befe16870f8d91fc613b461d01f39159c1e7116623209cd304ed89da3",
    },
  },
} as const;
export const fixedInspectionSources = {
  module:
    'import { useModal } from "./useModal.js";\nimport {\n  executionSnapshotJobPresentation,\n  executionJobsInReadingOrder,\n  executionResultSummary,\n} from "./execution-presentation.js";\nimport { useEffect, useRef, useState } from "react";\nimport { X, RefreshCw, Square, Check, FileText } from "lucide-react";\nimport { executionThreadGroups } from "./execution-thread-groups.js";\nimport { executionActivityStatus } from "./execution-activity.js";\nimport { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";\nimport { ApprovalDetails } from "./ApprovalCard.js";\nimport {\n  type ExecutionScope,\n  type ExecutionSnapshot,\n  type ExecutionControl,\n} from "../../../packages/core/src/execution.js";\nimport type { WorkspaceClient } from "./client.js";\nimport { useObservedRead } from "./useObservedRead.js";\nexport function ExecutionDialog({\n  client,\n  scope,\n  onClose,\n  onOpen,\n  embedded = false,\n  hideEmpty = false,\n}: {\n  client: WorkspaceClient;\n  scope: ExecutionScope;\n  onClose: () => void;\n  onOpen: (id: string) => void;\n  embedded?: boolean;\n  hideEmpty?: boolean;\n}) {\n  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n  useModal(dialog, undefined, !embedded);\n  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);\n  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];\n  const groups = executionThreadGroups(snapshot);\n  const grouped = !!snapshot?.threads && groups.length > 1;\n  const atReadLimit =\n    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;\n  const content = (\n    <>\n      {!embedded && (\n        <header>\n          <div>\n            <h2 id="execution-title">执行记录</h2>\n            <p className="muted">\n              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}\n              {snapshot?.limit ?? 100} 项执行\n            </p>\n          </div>\n          <button onClick={onClose} aria-label="关闭执行记录">\n            <X />\n          </button>\n        </header>\n      )}\n      {error && (\n        <p role="alert" className="delivery-error">\n          {error}\n        </p>\n      )}\n      {notice && (\n        <p role="status" className="execution-notice">\n          {notice}\n        </p>\n      )}\n      {(!embedded ||\n        error ||\n        !!snapshot?.jobs.length ||\n        !!snapshot?.approvals.length ||\n        snapshot?.threadsTruncated) && (\n        <div className="execution-dialog-toolbar">\n          <span className="muted">\n            {!!snapshot?.approvals.length && "单次授权"}\n          </span>\n          {embedded && atReadLimit && (\n            <small className="execution-history-bound">\n              当前为最近 {snapshot!.limit} 项执行\n            </small>\n          )}\n          {snapshot?.threadsTruncated && (\n            <small className="execution-history-bound">\n              部分子任务记录尚未载入\n            </small>\n          )}\n          <button aria-label="刷新执行记录" onClick={() => void refresh()}>\n            <RefreshCw />\n          </button>\n        </div>\n      )}\n      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}\n      <div className="execution-list">\n        {snapshot?.approvals.map((approval) => (\n          <section\n            className="execution-approval"\n            key={approval.request.approval_id}\n          >\n            <ApprovalDetails approval={approval} />\n            <div className="execution-actions">\n              <button\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "deny",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                拒绝\n              </button>\n              <button\n                className="primary"\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "allow-once",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                <Check />\n                仅允许这一次\n              </button>\n            </div>\n          </section>\n        ))}\n        {snapshot &&\n          !snapshot.jobs.length &&\n          !snapshot.approvals.length &&\n          !grouped && (\n            <p className="muted execution-empty">\n              {hideEmpty ? null : "暂无工具执行记录。"}\n            </p>\n          )}\n        {groups.map((group) => {\n          const status = group.thread\n            ? executionActivityStatus(group.thread, client.online && !error)\n            : undefined;\n          return (\n            <section\n              key={group.id}\n              className={grouped ? "execution-thread-group" : undefined}\n              data-execution-thread={group.thread?.id}\n              data-thread-depth={group.depth}\n              style={\n                grouped\n                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }\n                  : undefined\n              }\n            >\n              {grouped && group.thread && (\n                <header className="execution-thread-heading">\n                  <span\n                    className="execution-thread-state"\n                    data-status={status?.kind}\n                    title={status?.label}\n                  >\n                    <ExecutionStatusIcon kind={status?.kind} size={18} />\n                  </span>\n                  <div>\n                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>\n                    <strong title={group.thread.title}>\n                      {group.thread.title ||\n                        (group.depth > 0 ? "子任务" : "本次执行")}\n                    </strong>\n                  </div>\n                  <span className="execution-thread-status">\n                    {status?.label}\n                  </span>\n                </header>\n              )}\n              {grouped && group.thread?.summary && (\n                <p className="execution-thread-summary">\n                  {group.thread.summary}\n                </p>\n              )}\n              {grouped &&\n                group.depth > 0 &&\n                group.thread?.lifecycle === "open" && (\n                  <div className="execution-actions">\n                    <button\n                      disabled={!!busy || !!error || !client.online}\n                      onClick={() =>\n                        void control(\n                          {\n                            type: "cancel-thread",\n                            threadId: group.thread!.id,\n                            revision: group.thread!.revision,\n                          },\n                          group.thread!.id,\n                        )\n                      }\n                    >\n                      <Square />\n                      停止此子任务\n                    </button>\n                  </div>\n                )}\n              <div\n                className={grouped ? "execution-thread-timeline" : undefined}\n              >\n                {group.jobs.map((job) => {\n                  const presentation = executionSnapshotJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {presentation.statusLabel}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                })}\n              </div>\n            </section>\n          );\n        })}\n      </div>\n    </>\n  );\n  return embedded ? (\n    <section className="execution-details" aria-label="工具执行与审批">\n      {content}\n    </section>\n  ) : (\n    <dialog\n      ref={dialog}\n      className="create-dialog library-dialog execution-dialog"\n      aria-labelledby="execution-title"\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      {content}\n    </dialog>\n  );\n}\n',
  ExecutionDialog:
    'export function ExecutionDialog({\n  client,\n  scope,\n  onClose,\n  onOpen,\n  embedded = false,\n  hideEmpty = false,\n}: {\n  client: WorkspaceClient;\n  scope: ExecutionScope;\n  onClose: () => void;\n  onOpen: (id: string) => void;\n  embedded?: boolean;\n  hideEmpty?: boolean;\n}) {\n  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n  useModal(dialog, undefined, !embedded);\n  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);\n  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];\n  const groups = executionThreadGroups(snapshot);\n  const grouped = !!snapshot?.threads && groups.length > 1;\n  const atReadLimit =\n    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;\n  const content = (\n    <>\n      {!embedded && (\n        <header>\n          <div>\n            <h2 id="execution-title">执行记录</h2>\n            <p className="muted">\n              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}\n              {snapshot?.limit ?? 100} 项执行\n            </p>\n          </div>\n          <button onClick={onClose} aria-label="关闭执行记录">\n            <X />\n          </button>\n        </header>\n      )}\n      {error && (\n        <p role="alert" className="delivery-error">\n          {error}\n        </p>\n      )}\n      {notice && (\n        <p role="status" className="execution-notice">\n          {notice}\n        </p>\n      )}\n      {(!embedded ||\n        error ||\n        !!snapshot?.jobs.length ||\n        !!snapshot?.approvals.length ||\n        snapshot?.threadsTruncated) && (\n        <div className="execution-dialog-toolbar">\n          <span className="muted">\n            {!!snapshot?.approvals.length && "单次授权"}\n          </span>\n          {embedded && atReadLimit && (\n            <small className="execution-history-bound">\n              当前为最近 {snapshot!.limit} 项执行\n            </small>\n          )}\n          {snapshot?.threadsTruncated && (\n            <small className="execution-history-bound">\n              部分子任务记录尚未载入\n            </small>\n          )}\n          <button aria-label="刷新执行记录" onClick={() => void refresh()}>\n            <RefreshCw />\n          </button>\n        </div>\n      )}\n      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}\n      <div className="execution-list">\n        {snapshot?.approvals.map((approval) => (\n          <section\n            className="execution-approval"\n            key={approval.request.approval_id}\n          >\n            <ApprovalDetails approval={approval} />\n            <div className="execution-actions">\n              <button\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "deny",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                拒绝\n              </button>\n              <button\n                className="primary"\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "allow-once",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                <Check />\n                仅允许这一次\n              </button>\n            </div>\n          </section>\n        ))}\n        {snapshot &&\n          !snapshot.jobs.length &&\n          !snapshot.approvals.length &&\n          !grouped && (\n            <p className="muted execution-empty">\n              {hideEmpty ? null : "暂无工具执行记录。"}\n            </p>\n          )}\n        {groups.map((group) => {\n          const status = group.thread\n            ? executionActivityStatus(group.thread, client.online && !error)\n            : undefined;\n          return (\n            <section\n              key={group.id}\n              className={grouped ? "execution-thread-group" : undefined}\n              data-execution-thread={group.thread?.id}\n              data-thread-depth={group.depth}\n              style={\n                grouped\n                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }\n                  : undefined\n              }\n            >\n              {grouped && group.thread && (\n                <header className="execution-thread-heading">\n                  <span\n                    className="execution-thread-state"\n                    data-status={status?.kind}\n                    title={status?.label}\n                  >\n                    <ExecutionStatusIcon kind={status?.kind} size={18} />\n                  </span>\n                  <div>\n                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>\n                    <strong title={group.thread.title}>\n                      {group.thread.title ||\n                        (group.depth > 0 ? "子任务" : "本次执行")}\n                    </strong>\n                  </div>\n                  <span className="execution-thread-status">\n                    {status?.label}\n                  </span>\n                </header>\n              )}\n              {grouped && group.thread?.summary && (\n                <p className="execution-thread-summary">\n                  {group.thread.summary}\n                </p>\n              )}\n              {grouped &&\n                group.depth > 0 &&\n                group.thread?.lifecycle === "open" && (\n                  <div className="execution-actions">\n                    <button\n                      disabled={!!busy || !!error || !client.online}\n                      onClick={() =>\n                        void control(\n                          {\n                            type: "cancel-thread",\n                            threadId: group.thread!.id,\n                            revision: group.thread!.revision,\n                          },\n                          group.thread!.id,\n                        )\n                      }\n                    >\n                      <Square />\n                      停止此子任务\n                    </button>\n                  </div>\n                )}\n              <div\n                className={grouped ? "execution-thread-timeline" : undefined}\n              >\n                {group.jobs.map((job) => {\n                  const presentation = executionSnapshotJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {presentation.statusLabel}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                })}\n              </div>\n            </section>\n          );\n        })}\n      </div>\n    </>\n  );\n  return embedded ? (\n    <section className="execution-details" aria-label="工具执行与审批">\n      {content}\n    </section>\n  ) : (\n    <dialog\n      ref={dialog}\n      className="create-dialog library-dialog execution-dialog"\n      aria-labelledby="execution-title"\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      {content}\n    </dialog>\n  );\n}',
  lifecycle:
    '  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n  useModal(dialog, undefined, !embedded);\n  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n',
  refsAndState:
    '  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n  api.current = client;\n  const [observation, setObservation] = useState<{\n      scope: string;\n      snapshot: ExecutionSnapshot;\n    } | null>(null),\n    [error, setError] = useState(""),\n    [busy, setBusy] = useState(""),\n    [notice, setNotice] = useState("");\n  const [result, setResult] = useState<{\n    id: string;\n    text: string;\n    truncated: boolean;\n    available: boolean;\n  } | null>(null);\n',
  scopeProjection:
    "  const observationScope = JSON.stringify([\n    client.boot?.centerId,\n    client.boot?.principalId,\n    client.boot?.csrfToken,\n    scope,\n  ]);\n  const currentScope = useRef(observationScope);\n  currentScope.current = observationScope;\n  const snapshot =\n    observation?.scope === observationScope ? observation.snapshot : null;\n",
  observation:
    '  const refresh = useObservedRead({\n    scope: observationScope,\n    enabled: client.online,\n    revision: client.workspaceChangeRevision,\n    read: (signal) => api.current.executionSnapshot(scope, signal),\n    publish: (next) => {\n      setObservation({ scope: observationScope, snapshot: next });\n      setError("");\n    },\n    failed: (cause) =>\n      setError(cause instanceof Error ? cause.message : "无法读取执行状态。"),\n  });\n',
  modal: "  useModal(dialog, undefined, !embedded);\n",
  retirement:
    '  useEffect(() => {\n    mounted.current = true;\n\n    setObservation(null);\n    setResult(null);\n    setError("");\n    setBusy("");\n    setNotice("");\n    return () => {\n      mounted.current = false;\n    };\n  }, [observationScope]);\n',
  control:
    '  async function control(\n    action: ExecutionControl["action"],\n    threadId?: string,\n  ) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(\n      action.type === "cancel-job"\n        ? action.jobId\n        : action.type === "cancel-thread"\n          ? action.threadId\n          : action.approvalId,\n    );\n    setNotice("");\n    try {\n      await api.current.controlExecution({\n        scope: threadId ? { ...scope, threadId } : scope,\n        action,\n      });\n      if (current())\n        setNotice(action.type === "cancel-job" ? "已请求停止" : "已提交决定");\n    } catch (error) {\n      if (current())\n        setNotice(\n          error instanceof Error\n            ? error.message\n            : "结果未确认，请核对最新状态。",\n        );\n    } finally {\n      if (current()) {\n        setBusy("");\n        void refresh();\n      }\n    }\n  }\n',
  readResult:
    '  async function readResult(id: string) {\n    const origin = observationScope;\n    const current = () => mounted.current && currentScope.current === origin;\n    setBusy(id);\n    try {\n      const value = await api.current.executionResult(scope, id);\n      if (current()) setResult({ id, ...value });\n    } catch (error) {\n      if (current())\n        setNotice(error instanceof Error ? error.message : "无法读取结果。");\n    } finally {\n      if (current()) setBusy("");\n    }\n  }\n',
  producedId:
    '  let producedId: string | undefined;\n  if (result) {\n    try {\n      const data = JSON.parse(result.text);\n      if (\n        data.ok === true &&\n        typeof data.artifactId === "string" &&\n        (client.boot?.workspace.artifacts.some(\n          (a) => a.id === data.artifactId && a.projectId === scope.projectId,\n        ) ||\n          client.contentCatalog.some(\n            (entry) =>\n              entry.id === data.artifactId &&\n              entry.projectId === scope.projectId,\n          ))\n      )\n        producedId = data.artifactId;\n    } catch {\n      /* Ordinary tool output need not be JSON. */\n    }\n  }\n',
  renderTail:
    '  const jobs = executionJobsInReadingOrder(snapshot?.jobs ?? []);\n  const branchIds = [...new Set(jobs.map((job) => job.thread_id))];\n  const groups = executionThreadGroups(snapshot);\n  const grouped = !!snapshot?.threads && groups.length > 1;\n  const atReadLimit =\n    !!snapshot && snapshot.limit > 0 && jobs.length >= snapshot.limit;\n  const content = (\n    <>\n      {!embedded && (\n        <header>\n          <div>\n            <h2 id="execution-title">执行记录</h2>\n            <p className="muted">\n              {scope.threadId ? "本次执行" : "当前对话"} · 最近{" "}\n              {snapshot?.limit ?? 100} 项执行\n            </p>\n          </div>\n          <button onClick={onClose} aria-label="关闭执行记录">\n            <X />\n          </button>\n        </header>\n      )}\n      {error && (\n        <p role="alert" className="delivery-error">\n          {error}\n        </p>\n      )}\n      {notice && (\n        <p role="status" className="execution-notice">\n          {notice}\n        </p>\n      )}\n      {(!embedded ||\n        error ||\n        !!snapshot?.jobs.length ||\n        !!snapshot?.approvals.length ||\n        snapshot?.threadsTruncated) && (\n        <div className="execution-dialog-toolbar">\n          <span className="muted">\n            {!!snapshot?.approvals.length && "单次授权"}\n          </span>\n          {embedded && atReadLimit && (\n            <small className="execution-history-bound">\n              当前为最近 {snapshot!.limit} 项执行\n            </small>\n          )}\n          {snapshot?.threadsTruncated && (\n            <small className="execution-history-bound">\n              部分子任务记录尚未载入\n            </small>\n          )}\n          <button aria-label="刷新执行记录" onClick={() => void refresh()}>\n            <RefreshCw />\n          </button>\n        </div>\n      )}\n      {!snapshot && !error && <p className="muted">正在读取执行记录…</p>}\n      <div className="execution-list">\n        {snapshot?.approvals.map((approval) => (\n          <section\n            className="execution-approval"\n            key={approval.request.approval_id}\n          >\n            <ApprovalDetails approval={approval} />\n            <div className="execution-actions">\n              <button\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "deny",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                拒绝\n              </button>\n              <button\n                className="primary"\n                disabled={\n                  !!busy ||\n                  !!error ||\n                  !client.online ||\n                  client.approvalSubmitted(\n                    approval.request.approval_id,\n                    approval.fingerprint,\n                  )\n                }\n                onClick={() =>\n                  void control(\n                    {\n                      type: "allow-once",\n                      approvalId: approval.request.approval_id,\n                      fingerprint: approval.fingerprint,\n                    },\n                    grouped ? approval.request.thread_id : undefined,\n                  )\n                }\n              >\n                <Check />\n                仅允许这一次\n              </button>\n            </div>\n          </section>\n        ))}\n        {snapshot &&\n          !snapshot.jobs.length &&\n          !snapshot.approvals.length &&\n          !grouped && (\n            <p className="muted execution-empty">\n              {hideEmpty ? null : "暂无工具执行记录。"}\n            </p>\n          )}\n        {groups.map((group) => {\n          const status = group.thread\n            ? executionActivityStatus(group.thread, client.online && !error)\n            : undefined;\n          return (\n            <section\n              key={group.id}\n              className={grouped ? "execution-thread-group" : undefined}\n              data-execution-thread={group.thread?.id}\n              data-thread-depth={group.depth}\n              style={\n                grouped\n                  ? { paddingInlineStart: Math.min(group.depth, 3) * 8 }\n                  : undefined\n              }\n            >\n              {grouped && group.thread && (\n                <header className="execution-thread-heading">\n                  <span\n                    className="execution-thread-state"\n                    data-status={status?.kind}\n                    title={status?.label}\n                  >\n                    <ExecutionStatusIcon kind={status?.kind} size={18} />\n                  </span>\n                  <div>\n                    <small>{group.depth > 0 ? "子任务" : "主执行"}</small>\n                    <strong title={group.thread.title}>\n                      {group.thread.title ||\n                        (group.depth > 0 ? "子任务" : "本次执行")}\n                    </strong>\n                  </div>\n                  <span className="execution-thread-status">\n                    {status?.label}\n                  </span>\n                </header>\n              )}\n              {grouped && group.thread?.summary && (\n                <p className="execution-thread-summary">\n                  {group.thread.summary}\n                </p>\n              )}\n              {grouped &&\n                group.depth > 0 &&\n                group.thread?.lifecycle === "open" && (\n                  <div className="execution-actions">\n                    <button\n                      disabled={!!busy || !!error || !client.online}\n                      onClick={() =>\n                        void control(\n                          {\n                            type: "cancel-thread",\n                            threadId: group.thread!.id,\n                            revision: group.thread!.revision,\n                          },\n                          group.thread!.id,\n                        )\n                      }\n                    >\n                      <Square />\n                      停止此子任务\n                    </button>\n                  </div>\n                )}\n              <div\n                className={grouped ? "execution-thread-timeline" : undefined}\n              >\n                {group.jobs.map((job) => {\n                  const presentation = executionSnapshotJobPresentation(\n                    job,\n                    client.boot!.workspace,\n                  );\n                  return (\n                    <section\n                      key={job.id}\n                      className="execution-job"\n                      data-job-id={job.id}\n                    >\n                      <header>\n                        <strong title={presentation.title}>\n                          {presentation.title}\n                        </strong>\n                        <span className={`job-status ${job.status}`}>\n                          {presentation.statusLabel}\n                        </span>\n                      </header>\n                      {presentation.detail && (\n                        <p className="execution-object">\n                          {presentation.detail}\n                        </p>\n                      )}\n                      <small className="muted">\n                        {!grouped && branchIds.length > 1 && (\n                          <>分支 {branchIds.indexOf(job.thread_id) + 1} · </>\n                        )}\n                        {new Date(job.created_at).toLocaleString("zh-CN")}\n                      </small>\n                      {job.error && (\n                        <p className="delivery-error">{job.error}</p>\n                      )}\n                      {presentation.result && (\n                        <p\n                          className="execution-step-result"\n                          aria-label="返回结果解读"\n                          title={presentation.result}\n                        >\n                          {presentation.result}\n                        </p>\n                      )}\n                      <details>\n                        <summary>技术详情</summary>\n                        <pre>{JSON.stringify(job.request, null, 2)}</pre>\n                        <small>执行节点：{job.target_id} · </small>\n                        <small>执行 ID：{job.id}</small>\n                      </details>\n                      <div className="execution-actions">\n                        {job.result_event_id && (\n                          <button\n                            disabled={!!busy}\n                            onClick={() => void readResult(job.id)}\n                          >\n                            查看结果\n                          </button>\n                        )}\n                        {["queued", "waiting_approval", "running"].includes(\n                          job.status,\n                        ) && (\n                          <button\n                            disabled={\n                              !!busy || !!error || !!job.cancel_requested_at\n                            }\n                            onClick={() =>\n                              void control(\n                                {\n                                  type: "cancel-job",\n                                  jobId: job.id,\n                                  revision: job.revision,\n                                },\n                                grouped ? job.thread_id : undefined,\n                              )\n                            }\n                          >\n                            <Square />\n                            停止此项执行\n                          </button>\n                        )}\n                        {job.exit_code !== null && (\n                          <small className="muted">\n                            退出码 {job.exit_code}\n                          </small>\n                        )}\n                      </div>\n                      {result?.id === job.id && (\n                        <div className="execution-result">\n                          {executionResultSummary(result.text) && (\n                            <p>{executionResultSummary(result.text)}</p>\n                          )}\n                          {producedId && (\n                            <button\n                              onClick={() => {\n                                onOpen(producedId!);\n                                onClose();\n                              }}\n                            >\n                              <FileText />\n                              {client.boot?.workspace.artifacts.find(\n                                (a) => a.id === producedId,\n                              )?.title ??\n                                client.contentCatalog.find(\n                                  (entry) => entry.id === producedId,\n                                )?.title ??\n                                "打开成果"}\n                            </button>\n                          )}\n                          <details>\n                            <summary>完整返回内容</summary>\n                            <pre>\n                              {result.available\n                                ? result.text || "执行返回了空内容。"\n                                : "尚无最终结果。"}\n                            </pre>\n                          </details>\n                          {result.truncated && (\n                            <small>结果较长，当前显示前 64,000 个字符。</small>\n                          )}\n                        </div>\n                      )}\n                    </section>\n                  );\n                })}\n              </div>\n            </section>\n          );\n        })}\n      </div>\n    </>\n  );\n  return embedded ? (\n    <section className="execution-details" aria-label="工具执行与审批">\n      {content}\n    </section>\n  ) : (\n    <dialog\n      ref={dialog}\n      className="create-dialog library-dialog execution-dialog"\n      aria-labelledby="execution-title"\n      onCancel={(e) => {\n        e.preventDefault();\n        onClose();\n      }}\n    >\n      {content}\n    </dialog>\n  );\n}',
  rendererRefPrefix:
    "  const dialog = useRef<HTMLDialogElement>(null),\n    api = useRef(client),\n    mounted = useRef(true);\n",
} as const;

import { useModal } from "../../apps/web/src/useModal.js";
import {
  executionSnapshotJobPresentation,
  executionJobsInReadingOrder,
  executionResultSummary,
} from "../../apps/web/src/execution-presentation.js";
import React, { useEffect, useRef, useState } from "react";
import { X, RefreshCw, Square, Check, FileText } from "lucide-react";
import { executionThreadGroups } from "../../apps/web/src/execution-thread-groups.js";
import { executionActivityStatus } from "../../apps/web/src/execution-activity.js";
import { ExecutionStatusIcon } from "../../apps/web/src/ExecutionStatusIcon.js";
import { ApprovalDetails } from "../../apps/web/src/ApprovalCard.js";
import {
  type ExecutionScope,
  type ExecutionSnapshot,
  type ExecutionControl,
} from "../../packages/core/src/execution.js";
import type { WorkspaceClient } from "../../apps/web/src/client.js";
import { useObservedRead } from "../../apps/web/src/useObservedRead.js";

// Isolated Node tsx uses classic JSX; production Vite uses the automatic runtime.
void React;
import type { RefObject } from "react";

/* FIXED_INSPECTION_DIALOG_BEGIN */
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
                  const presentation = executionSnapshotJobPresentation(
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
                          {presentation.statusLabel}
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
/* FIXED_INSPECTION_DIALOG_END */

export type FixedInspectionOptions = {
  client: Pick<
    WorkspaceClient,
    | "boot"
    | "online"
    | "workspaceChangeRevision"
    | "executionSnapshot"
    | "executionResult"
    | "controlExecution"
    | "contentCatalog"
  >;
  scope: ExecutionScope;
  dialog: RefObject<HTMLDialogElement | null>;
  embedded: boolean;
};

// Only original first native-dialog ref is borrowed from the consuming renderer.
// Everything else below is the original contiguous lifecycle/commands/projection.
export function useFixedExecutionInspection({
  client,
  scope,
  dialog,
  embedded,
}: FixedInspectionOptions) {
  /* FIXED_INSPECTION_RECIPE_BEGIN */
  const api = useRef(client),
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
  /* FIXED_INSPECTION_RECIPE_END */
  return {
    snapshot,
    error,
    busy,
    notice,
    result,
    producedId,
    refresh,
    control,
    readResult,
  };
}
