import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  formatContextCapacity,
  latestContextUsage,
  sessionContextBudgetSnapshotSchema,
  type SessionContextBudgetSnapshot,
  type SessionContextUsage,
} from "../../../packages/core/src/session-context-budget.js";
import type { SessionEvaluationScope } from "../../../packages/core/src/session-evaluation.js";
import {
  applicationCall,
  applicationIdentity,
} from "./application-transport.js";
import { ComposerOptions } from "./ComposerOptions.js";

export function ComposerContextCapacity({
  scope,
  identityGeneration,
  policyFingerprint,
  online,
  liveUsages = [],
}: {
  scope?: SessionEvaluationScope;
  identityGeneration: string;
  policyFingerprint?: string | null;
  online: boolean;
  liveUsages?: SessionContextUsage[];
}) {
  const identity = applicationIdentity();
  const valueId = useId();
  const key = JSON.stringify([
    identity,
    identityGeneration,
    scope,
    policyFingerprint,
  ]);
  const current = useRef({ key, mounted: true });
  current.current.key = key;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{
    key: string;
    value?: SessionContextBudgetSnapshot;
    loading: boolean;
    error?: string;
  }>({ key, loading: true });
  const [edit, setEdit] = useState<{
    key: string;
    automatic: boolean;
    kilo: string;
  }>();
  const [saving, setSaving] = useState(false);
  const writing = useRef(false);
  const [writeFailure, setWriteFailure] = useState<{
    key: string;
    message: string;
  }>();
  useEffect(() => {
    current.current.mounted = true;
    return () => {
      current.current.mounted = false;
    };
  }, []);
  useEffect(() => {
    if (!scope || !online) return;
    const controller = new AbortController(),
      expected = key;
    setState((previous) => ({
      key: expected,
      value: previous.key === expected ? previous.value : undefined,
      loading: true,
    }));
    void applicationCall("session-context-budget.read", scope, {
      identityGeneration,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
    })
      .then((raw) => {
        if (controller.signal.aborted || current.current.key !== expected)
          return;
        const value = sessionContextBudgetSnapshotSchema.parse(raw);
        if (
          value.scope.projectId !== scope.projectId ||
          value.scope.conversationId !== scope.conversationId
        )
          throw new Error("上下文容量的会话范围不匹配。");
        setState({ key: expected, value, loading: false });
        setWriteFailure(undefined);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && current.current.key === expected)
          setState((previous) => ({
            ...previous,
            key: expected,
            loading: false,
            error: error instanceof Error ? error.message : "暂时无法读取容量",
          }));
      });
    return () => controller.abort();
    // This display never gates typing or input admission. Reads are keyed to
    // scope/model or an explicit gesture; streamed tokens do not trigger reads.
  }, [key, online, retry]);
  const refresh = useCallback(() => {
    setEdit(undefined);
    setRetry((value) => value + 1);
  }, []);
  const onOpenChange = useCallback(
    (open: boolean) => {
      setEdit(undefined);
      if (open && online) refresh();
    },
    [online, refresh],
  );
  const actual = state.key === key ? state.value : undefined;
  const loading = online && (state.key !== key || state.loading);
  const inputTokens = actual?.inputTokens;
  const amount = inputTokens ? formatContextCapacity(inputTokens) : null;
  const usage =
    actual?.contextId && actual.runtimeSessionId && actual.model
      ? latestContextUsage([actual.usage, ...liveUsages], {
          contextId: actual.contextId,
          sessionId: actual.runtimeSessionId,
          model: actual.model,
        })
      : null;
  const ratio = usage && inputTokens ? usage.inputTokens / inputTokens : null;
  const percent = ratio === null ? null : Math.round(ratio * 100);
  const estimated = usage?.accuracy !== "exact";
  const editKey = JSON.stringify([key, actual?.revision, actual?.model]);
  const draft =
    edit?.key === editKey
      ? edit
      : {
          key: editKey,
          automatic: actual?.requestedTokens === null,
          kilo: String((actual?.requestedTokens ?? inputTokens ?? 0) / 1024),
        };
  const requested = draft.automatic
    ? null
    : Math.round(Number(draft.kilo) * 1024);
  const maxTokens = actual?.physicalInputTokens ?? 0;
  const valid =
    draft.automatic ||
    (!!draft.kilo.trim() &&
      requested !== null &&
      Number.isSafeInteger(requested) &&
      requested > 0 &&
      requested <= maxTokens);
  const dirty = !!actual && requested !== actual.requestedTokens;
  const blocked = writeFailure?.key === key;
  const editable =
    !!actual?.canUpdate && online && !loading && !saving && !blocked;
  const change = (kilo: string) =>
    setEdit({ key: editKey, automatic: false, kilo });
  async function apply() {
    if (
      !scope ||
      !actual ||
      !editable ||
      !valid ||
      !dirty ||
      actual.revision === null ||
      !actual.model ||
      writing.current
    )
      return;
    writing.current = true;
    setSaving(true);
    const expected = key;
    try {
      const result = sessionContextBudgetSnapshotSchema.parse(
        await applicationCall(
          "session-context-budget.update",
          {
            ...scope,
            requestedTokens: requested,
            expectedRevision: actual.revision,
            expectedModel: actual.model,
          },
          { identityGeneration, signal: AbortSignal.timeout(15000) },
        ),
      );
      if (!current.current.mounted || current.current.key !== expected) return;
      if (
        result.scope.projectId !== scope.projectId ||
        result.scope.conversationId !== scope.conversationId
      )
        throw new Error("容量写入回执的会话范围不匹配。");
      setState({ key: expected, value: result, loading: false });
      setEdit(undefined);
      setWriteFailure(undefined);
    } catch (error) {
      if (current.current.mounted && current.current.key === expected)
        setWriteFailure({
          key: expected,
          message:
            error instanceof Error
              ? error.message
              : "容量保存结果未确认，请重新读取。",
        });
    } finally {
      writing.current = false;
      if (current.current.mounted) setSaving(false);
    }
  }
  if (!scope) return null;
  const meterText =
    percent === null
      ? (amount ?? "上下文")
      : (estimated ? "≈" : "") + percent + "%";
  const description =
    usage && inputTokens
      ? "输入" +
        (estimated ? "估算 " : " ") +
        formatContextCapacity(usage.inputTokens) +
        " / " +
        amount +
        "，占用 " +
        percent +
        "%"
      : "查看并调整当前上下文容量";
  return (
    <ComposerOptions
      label="上下文容量"
      menuLabel="上下文容量"
      description={description}
      initialFocus="panel"
      triggerClassName="composer-capacity-trigger"
      menuClassName="composer-capacity-menu"
      options={[]}
      onOpenChange={onOpenChange}
      triggerIcon={
        <>
          <svg
            className="composer-capacity-ring"
            data-pressure={
              ratio !== null && ratio >= 0.875 ? "high" : undefined
            }
            viewBox="0 0 20 20"
            aria-hidden="true"
          >
            <circle className="capacity-ring-track" cx="10" cy="10" r="7.5" />
            {ratio !== null && (
              <circle
                className="capacity-ring-fill"
                cx="10"
                cy="10"
                r="7.5"
                pathLength="100"
                strokeDasharray="100"
                strokeDashoffset={100 - Math.min(1, Math.max(0, ratio)) * 100}
              />
            )}
          </svg>
          <span>{meterText}</span>
          {percent !== null && amount && (
            <span className="composer-capacity-ceiling">· {amount}</span>
          )}
        </>
      }
      content={() => (
        <div
          className="composer-capacity-details"
          onKeyDown={(event) => {
            if (event.key !== "Escape") {
              event.stopPropagation();
              if (
                event.key === "Enter" &&
                event.target instanceof HTMLInputElement
              ) {
                event.preventDefault();
                void apply();
              }
            }
          }}
        >
          <div className="composer-capacity-heading">
            <span>上下文</span>
            <span className="composer-capacity-percent">
              {percent === null
                ? "尚未估算"
                : (estimated ? "≈ " : "") + percent + "%"}
            </span>
          </div>
          <div className="composer-capacity-usage">
            <strong>
              {usage
                ? (estimated ? "≈ " : "") +
                  formatContextCapacity(usage.inputTokens)
                : "—"}
            </strong>
            <span>/ {amount ?? "—"}</span>
          </div>
          <div
            className="composer-capacity-bar"
            role="progressbar"
            aria-label="已用上下文"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              percent === null ? undefined : Math.min(percent, 100)
            }
            aria-valuetext={usage ? description : "暂无当前模型的输入估算"}
            data-pressure={
              ratio !== null && ratio >= 0.875 ? "high" : undefined
            }
          >
            <span
              style={{
                width:
                  (ratio === null
                    ? 0
                    : Math.min(100, Math.max(0, ratio * 100))) + "%",
              }}
            />
          </div>
          <p className="composer-capacity-measured">
            {usage
              ? (!online ? "离线 · " : "") +
                "最近输入" +
                (estimated ? "估算" : "计数") +
                " · " +
                new Date(usage.measuredAt).toLocaleTimeString("zh-CN", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "发送请求后显示输入估算"}
          </p>
          {actual?.source === "runtime" && (
            <section
              className="composer-capacity-editor"
              aria-busy={loading || saving}
            >
              <div className="composer-capacity-setting-title">
                <label htmlFor={valueId}>最大上下文</label>
                <button
                  type="button"
                  className="composer-capacity-auto"
                  aria-pressed={draft.automatic}
                  disabled={!editable}
                  onClick={() =>
                    setEdit({
                      key: editKey,
                      automatic: true,
                      kilo: String(maxTokens / 1024),
                    })
                  }
                >
                  自动
                </button>
              </div>
              <div className="composer-capacity-input-row">
                <input
                  type="range"
                  aria-label="最大上下文滑块"
                  min="1"
                  max={Math.max(1, maxTokens / 1024)}
                  value={
                    draft.automatic
                      ? (inputTokens ?? 0) / 1024
                      : Number(draft.kilo) || 1
                  }
                  disabled={!editable}
                  onChange={(event) => change(event.target.value)}
                />
                <span className="composer-capacity-number">
                  <input
                    id={valueId}
                    aria-label="最大上下文 K"
                    type="number"
                    inputMode="decimal"
                    min="0.001"
                    step="any"
                    max={maxTokens / 1024}
                    value={draft.kilo}
                    disabled={!editable}
                    onChange={(event) => change(event.target.value)}
                  />
                  <span>K</span>
                </span>
              </div>
              <p className="composer-capacity-limit">
                当前模型可用上限 {formatContextCapacity(maxTokens)}
              </p>
              {(actual.windowTokens || actual.outputTokens) && (
                <dl>
                  {actual.windowTokens && (
                    <div>
                      <dt>模型总容量</dt>
                      <dd>{formatContextCapacity(actual.windowTokens)}</dd>
                    </div>
                  )}
                  {actual.outputTokens && (
                    <div>
                      <dt>留给回答</dt>
                      <dd>{formatContextCapacity(actual.outputTokens)}</dd>
                    </div>
                  )}
                </dl>
              )}
              {(blocked || state.error) && (
                <p className="composer-capacity-error" role="alert">
                  {blocked ? writeFailure.message : state.error}
                </p>
              )}
              <div className="composer-capacity-footer">
                <span title="同一共享上下文内的对话共用此上限；正在发出的请求不会被打断。">
                  共享上限 · 下次请求生效
                </span>
                {blocked || state.error ? (
                  <button
                    type="button"
                    className="text-button"
                    onClick={refresh}
                    disabled={!online || saving}
                  >
                    重新读取
                  </button>
                ) : actual.canUpdate ? (
                  <button
                    type="button"
                    className="composer-capacity-apply"
                    disabled={!editable || !valid || !dirty}
                    onClick={() => void apply()}
                  >
                    {saving ? "应用中…" : "应用"}
                  </button>
                ) : (
                  <span>只读</span>
                )}
              </div>
            </section>
          )}
          {actual?.source === "not_started" && (
            <p>首次发送后可调整当前上下文容量。</p>
          )}
          {!actual && (
            <p>
              {!online
                ? "连接后可查看容量。"
                : state.key === key && state.error
                  ? "容量暂时无法读取。"
                  : "正在读取当前上下文…"}
            </p>
          )}
          {!actual && state.key === key && state.error && online && (
            <button type="button" className="text-button" onClick={refresh}>
              重新读取
            </button>
          )}
        </div>
      )}
    />
  );
}
