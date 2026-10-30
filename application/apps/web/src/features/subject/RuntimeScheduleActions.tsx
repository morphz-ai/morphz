import { useRef, useState } from "react";
import {
  CalendarClock,
  ChevronDown,
  Pause,
  Play,
  Square,
  X,
} from "lucide-react";
import type { ExecutionActivity } from "../../../../../packages/core/src/conversation.js";
import type { ScheduleControl } from "../../../../../packages/core/src/schedule-control.js";
import type { WorkspaceClient } from "../../client.js";
import { applicationCall } from "../../application-transport.js";
import { ComposerOptions } from "../../ComposerOptions.js";
import { useModal } from "../../useModal.js";

type Schedule = NonNullable<ExecutionActivity["schedules"]>[number];
export function RuntimeScheduleActions({
  row,
  client,
  disabled,
}: {
  row: Schedule;
  client: WorkspaceClient;
  disabled: boolean;
}) {
  const [editing, setEditing] = useState<{
    row: Schedule;
    cancel: boolean;
  } | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false),
    identity = useRef(client.boot!.csrfToken);
  identity.current = client.boot!.csrfToken;
  const unavailable =
    disabled || busy || !["queued", "paused"].includes(row.status);
  async function control(
    selected: Schedule,
    action: ScheduleControl["action"],
    timing?: { notBefore: string; intervalSeconds: number | null },
  ) {
    if (pending.current || unavailable) return;
    const origin = client.boot!.csrfToken;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await applicationCall(
        "schedule.control",
        {
          scope: {
            projectId: selected.projectId,
            conversationId: selected.conversationId,
            inputId: selected.inputId,
            threadId: selected.threadId,
            artifactId: null,
          },
          scheduleId: selected.scheduleId,
          revision: selected.revision,
          action,
          ...timing,
        },
        { identityGeneration: origin, signal: AbortSignal.timeout(12000) },
      );
      if (identity.current === origin) setEditing(null);
      await client.refreshView();
    } catch (cause) {
      if (identity.current === origin)
        setError(
          cause instanceof Error
            ? cause.message
            : "操作未确认，请核对定时任务状态。",
        );
    } finally {
      pending.current = false;
      if (identity.current === origin) setBusy(false);
    }
  }
  return (
    <span className="runtime-schedule-actions">
      <ComposerOptions
        label="调整定时任务"
        menuLabel="定时任务操作"
        triggerDisabled={unavailable}
        options={[
          {
            label: row.status === "paused" ? "继续定时任务" : "暂停定时任务",
            icon: row.status === "paused" ? <Play /> : <Pause />,
            onSelect: () =>
              void control(row, row.status === "paused" ? "resume" : "pause"),
          },
          {
            label: "调整时间…",
            icon: <CalendarClock />,
            onSelect: () => setEditing({ row: { ...row }, cancel: false }),
          },
          {
            label: "取消安排…",
            icon: <Square />,
            onSelect: () => setEditing({ row: { ...row }, cancel: true }),
          },
        ]}
      />
      {error && (
        <span className="execution-control-notice" role="alert">
          {error}
        </span>
      )}
      {editing && (
        <ScheduleEditor
          row={editing.row}
          cancel={editing.cancel}
          disabled={unavailable}
          busy={busy}
          error={error}
          onClose={() => {
            if (!busy) setEditing(null);
          }}
          onSave={(timing) =>
            control(
              editing.row,
              editing.cancel ? "cancel" : "reschedule",
              timing,
            )
          }
        />
      )}
    </span>
  );
}

function ScheduleEditor({
  row,
  cancel,
  disabled,
  busy,
  error,
  onClose,
  onSave,
}: {
  row: Schedule;
  cancel: boolean;
  disabled: boolean;
  busy: boolean;
  error: string;
  onClose(): void;
  onSave(timing?: {
    notBefore: string;
    intervalSeconds: number | null;
  }): Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModal(dialog);
  const date = new Date(row.notBefore ?? Date.now());
  const [time, setTime] = useState(
    new Date(date.getTime() - date.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 19),
  );
  const [interval, setInterval] = useState(
    row.intervalSeconds?.toString() ?? "",
  );
  const valid =
    Number.isFinite(Date.parse(time)) &&
    (!interval ||
      (Number.isSafeInteger(Number(interval)) && Number(interval) > 0));
  return (
    <dialog
      ref={dialog}
      className="create-dialog execution-control-dialog"
      aria-label={cancel ? "取消安排" : "调整定时任务"}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header>
        <h2>{cancel ? "取消安排" : "调整时间"}</h2>
        <button
          className="icon-button"
          aria-label="关闭"
          disabled={busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      <details className="execution-control-intent">
        <summary>
          <span>{row.intent}</span>
          <ChevronDown aria-hidden="true" />
        </summary>
        <p>{row.intent}</p>
      </details>
      {cancel ? (
        <p className="muted">取消这条安排。已执行的操作会保留。</p>
      ) : (
        <div className="execution-control-fields">
          <label>
            执行时间
            <input
              type="datetime-local"
              step="1"
              aria-label="执行时间"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              disabled={busy}
            />
          </label>
          <label>
            重复间隔（秒，留空为单次）
            <input
              type="number"
              min="1"
              step="1"
              aria-label="重复间隔（秒）"
              value={interval}
              onChange={(event) => setInterval(event.target.value)}
              disabled={busy}
            />
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="delivery-error">
          {error}
        </p>
      )}
      <footer>
        <button disabled={busy} onClick={onClose}>
          返回
        </button>
        <button
          className={cancel ? "danger" : "primary"}
          disabled={disabled || (!cancel && !valid)}
          onClick={() =>
            void onSave(
              cancel
                ? undefined
                : {
                    notBefore: new Date(time).toISOString(),
                    intervalSeconds: interval ? Number(interval) : null,
                  },
            )
          }
        >
          {busy ? "正在提交…" : cancel ? "取消安排" : "保存"}
        </button>
      </footer>
    </dialog>
  );
}
