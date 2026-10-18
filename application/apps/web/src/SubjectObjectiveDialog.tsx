import { useEffect, useId, useRef, useState } from "react";
import { Pause, Play, Trash2, X } from "lucide-react";
import type { ExecutionActivity } from "../../../packages/core/src/conversation.js";
import type { ObjectiveControl } from "../../../packages/core/src/objective-control.js";
import type { WorkspaceClient } from "./client.js";
import { applicationCall } from "./application-transport.js";
import { objectiveDetailStatus } from "./subject-sidebar-model.js";
import { useModal } from "./useModal.js";

type Goal = NonNullable<ExecutionActivity["objectives"]>[number];

export function SubjectObjectiveDialog({
  goal,
  client,
  fresh,
  onClose,
}: {
  goal: Goal;
  client: WorkspaceClient;
  fresh: boolean;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    deleteAction = useRef<HTMLButtonElement>(null),
    wasConfirming = useRef(false),
    pending = useRef(false),
    alive = useRef(true);
  const titleId = useId(),
    warningId = useId();
  const [confirmation, setConfirmation] = useState<Goal | null>(null);
  const [busy, setBusy] = useState<ObjectiveControl["action"] | "">("");
  const [error, setError] = useState("");
  useModal(dialog);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (confirmation) cancel.current?.focus();
    else if (wasConfirming.current) deleteAction.current?.focus();
    wasConfirming.current = !!confirmation;
  }, [confirmation]);
  async function control(action: ObjectiveControl["action"], selected = goal) {
    if (
      pending.current ||
      !fresh ||
      !selected.controlAllowed ||
      !selected.revision ||
      !client.online
    )
      return;
    pending.current = true;
    setBusy(action);
    setError("");
    let deleted = false;
    try {
      await applicationCall("objective.control", {
        objectiveId: selected.id,
        projectId: selected.projectId,
        conversationId: selected.conversationId,
        revision: selected.revision,
        action,
      } satisfies ObjectiveControl);
      deleted = action === "delete";
      if (alive.current) setConfirmation(null);
    } catch (cause) {
      if (alive.current) {
        setConfirmation(null);
        setError(
          cause instanceof Error
            ? cause.message
            : "操作结果未确认，请核对最新状态。",
        );
      }
    } finally {
      const refreshed = await client.refreshView().catch(() => false);
      pending.current = false;
      if (alive.current) {
        setBusy("");
        if (deleted) onClose();
        else if (!refreshed) setError("最新状态暂时无法读取，请核对后再操作。");
      }
    }
  }
  const displayed = confirmation ?? goal;
  const disabled =
    !!busy ||
    !fresh ||
    !client.online ||
    !goal.controlAllowed ||
    !goal.revision;
  return (
    <dialog
      ref={dialog}
      className="create-dialog subject-objective-dialog"
      aria-labelledby={titleId}
      aria-describedby={confirmation ? warningId : undefined}
      data-confirmation={!!confirmation}
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!pending.current) onClose();
      }}
    >
      <header>
        <div className="subject-objective-dialog-heading">
          <h2 id={titleId}>{confirmation ? "删除这个目标？" : "目标"}</h2>
          <p className="muted" role="status">
            {fresh
              ? objectiveDetailStatus(
                  goal.status,
                  goal.readiness,
                  goal.waitKinds,
                )
              : "目标状态暂时无法读取"}
          </p>
        </div>
        <button
          className="icon-button"
          aria-label="关闭目标"
          disabled={!!busy}
          onClick={onClose}
        >
          <X />
        </button>
      </header>
      {confirmation && (
        <p id={warningId} className="subject-objective-delete-warning">
          删除会停止目标的自动推进，保留已有内容和执行记录；已发生的操作不会撤回。
        </p>
      )}
      <div
        className="subject-objective-dialog-text"
        role="region"
        aria-label="完整目标"
        tabIndex={0}
      >
        {displayed.title}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {(confirmation || goal.status !== "cancelled") && (
        <footer
          role="group"
          aria-label={confirmation ? "删除目标确认" : "目标操作"}
        >
          {confirmation ? (
            <>
              <button
                ref={cancel}
                className="secondary-action"
                disabled={!!busy}
                onClick={() => {
                  setConfirmation(null);
                  setError("");
                }}
              >
                保留目标
              </button>
              <button
                className="primary danger"
                disabled={disabled}
                onClick={() => void control("delete", confirmation)}
              >
                {busy === "delete" ? "删除中…" : "确认删除"}
              </button>
            </>
          ) : (
            <>
              {goal.status === "active" && (
                <button
                  className="secondary-action"
                  disabled={disabled}
                  onClick={() => void control("pause")}
                >
                  <Pause />
                  {busy === "pause" ? "暂停中…" : "暂停"}
                </button>
              )}
              {["paused", "blocked"].includes(goal.status) && (
                <button
                  className="secondary-action"
                  disabled={disabled}
                  onClick={() => void control("resume")}
                >
                  <Play />
                  {busy === "resume" ? "恢复中…" : "恢复"}
                </button>
              )}
              {goal.status !== "cancelled" && (
                <button
                  ref={deleteAction}
                  className="secondary-action danger"
                  data-variant="ghost"
                  disabled={disabled}
                  onClick={() => {
                    setConfirmation({ ...goal });
                    setError("");
                  }}
                >
                  <Trash2 />
                  删除
                </button>
              )}
            </>
          )}
        </footer>
      )}
    </dialog>
  );
}
