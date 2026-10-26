import { useEffect, useRef, useState } from "react";
import { Pause, Pencil, Play, Square, X } from "lucide-react";
import type {
  ExecutionControl,
  ExecutionReadScope,
} from "../../../../../packages/core/src/execution.js";
import { ComposerOptions } from "../../ComposerOptions.js";
import { Tooltip } from "../../ui/Tooltip.js";
import { useModal } from "../../useModal.js";

type Thread = {
  id: string;
  revision: number;
  lifecycle: string;
  controlState?: string;
};
/** These are controls for one exact selected execution. A delegated Agent has
 * a distinct durable cancellation edge, never ordinary Thread controls. */
export function ExecutionControlActions({
  scope,
  thread,
  disabled,
  onControl,
  stopLabel = "停止",
  compact = true,
}: {
  scope: ExecutionReadScope;
  thread: Thread;
  disabled: boolean;
  onControl(action: ExecutionControl["action"]): Promise<unknown>;
  stopLabel?: string;
  compact?: boolean;
}) {
  const [confirmation, setConfirmation] = useState<{
    kind: "correct" | "delegation";
    thread: Thread;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [stopRequested, setStopRequested] = useState(false),
    [stopping, setStopping] = useState(false);
  const pending = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const delegated = "runtime" in scope && !!scope.runtime.delegation;
  const paused = thread.controlState === "paused";
  const knownControl =
    !delegated && ["active", "paused"].includes(thread.controlState ?? "");
  const unavailable =
    disabled || busy || stopRequested || thread.lifecycle !== "open";
  async function submit(action: ExecutionControl["action"]) {
    if (pending.current || unavailable) return;
    pending.current = true;
    setBusy(true);
    setStopping(action.type.startsWith("cancel-"));
    setNotice("");
    try {
      await onControl(action);
      if (alive.current) {
        setConfirmation(null);
        if (action.type.startsWith("cancel-")) setStopRequested(true);
      }
    } catch (cause) {
      if (alive.current)
        setNotice(
          cause instanceof Error
            ? cause.message
            : "操作未确认，请核对最新状态。",
        );
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setStopping(false);
      }
    }
  }
  return (
    <span className="execution-control-actions">
      {knownControl && (
        <Tooltip label={paused ? "继续此执行" : "暂停此执行"}>
          <button
            type="button"
            className="icon-button"
            aria-label={paused ? "继续此执行" : "暂停此执行"}
            disabled={
              unavailable ||
              !["active", "paused"].includes(thread.controlState ?? "")
            }
            onClick={() =>
              void submit({
                type: paused ? "resume-thread" : "pause-thread",
                threadId: thread.id,
                revision: thread.revision,
              })
            }
          >
            {paused ? <Play /> : <Pause />}
          </button>
        </Tooltip>
      )}
      {knownControl && (
        <ComposerOptions
          below
          label="更多执行操作"
          menuLabel="执行操作"
          triggerDisabled={unavailable}
          options={[
            {
              label: "纠正并继续",
              icon: <Pencil />,
              disabled: !["active", "paused"].includes(
                thread.controlState ?? "",
              ),
              onSelect: () =>
                setConfirmation({ kind: "correct", thread: { ...thread } }),
            },
          ]}
        />
      )}
      <Tooltip
        label={
          stopping
            ? "正在请求停止"
            : stopRequested
              ? "停止请求已发送"
              : delegated
                ? "停止子智能体"
                : compact
                  ? "停止当前执行"
                  : stopLabel
        }
      >
        <button
          type="button"
          className={`${compact ? "icon-button " : ""}execution-stop-thread`}
          aria-label={delegated ? "停止子智能体" : stopLabel}
          disabled={unavailable}
          aria-busy={busy}
          onClick={() =>
            delegated
              ? setConfirmation({ kind: "delegation", thread: { ...thread } })
              : void submit({
                  type: "cancel-thread",
                  threadId: thread.id,
                  revision: thread.revision,
                })
          }
        >
          <Square aria-hidden="true" />
          {!compact && <span>{stopLabel}</span>}
        </button>
      </Tooltip>
      {(stopping || stopRequested) && (
        <span className="sr-only" role="status">
          {stopping ? "正在请求停止" : "停止请求已发送"}
        </span>
      )}
      {notice && (
        <span className="execution-control-notice" role="status">
          {notice}
        </span>
      )}
      {confirmation && (
        <ExecutionControlConfirmation
          kind={confirmation.kind}
          busy={busy}
          disabled={unavailable}
          onClose={() => {
            if (!busy) setConfirmation(null);
          }}
          onSubmit={(intent) =>
            submit(
              confirmation.kind === "delegation"
                ? { type: "cancel-delegation" }
                : {
                    type: "supersede-thread",
                    threadId: confirmation.thread.id,
                    revision: confirmation.thread.revision,
                    intent,
                  },
            )
          }
        />
      )}
    </span>
  );
}

function ExecutionControlConfirmation({
  kind,
  busy,
  disabled,
  onClose,
  onSubmit,
}: {
  kind: "correct" | "delegation";
  busy: boolean;
  disabled: boolean;
  onClose(): void;
  onSubmit(intent: string): Promise<unknown>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    [intent, setIntent] = useState("");
  useModal(dialog);
  const correction = kind === "correct";
  return (
    <dialog
      ref={dialog}
      className="create-dialog execution-control-dialog"
      aria-label={correction ? "纠正并继续" : "停止子智能体"}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{correction ? "纠正并继续" : "停止子智能体"}</h2>
        <button
          className="icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <p className="muted">
        {correction
          ? "更新此执行的要求后继续。已完成的操作会保留。"
          : "停止这次委派及其下属子智能体。已完成的操作会保留。"}
      </p>
      {correction && (
        <textarea
          aria-label="修正后的执行要求"
          rows={4}
          maxLength={64000}
          value={intent}
          disabled={busy}
          onChange={(event) => setIntent(event.target.value)}
          placeholder="写下修正后的完整执行要求…"
        />
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className={correction ? "primary" : "danger"}
          disabled={disabled || (correction && !intent.trim())}
          onClick={() => void onSubmit(intent.trim())}
        >
          {busy ? "正在提交…" : correction ? "纠正并继续" : "停止子智能体"}
        </button>
      </footer>
    </dialog>
  );
}
