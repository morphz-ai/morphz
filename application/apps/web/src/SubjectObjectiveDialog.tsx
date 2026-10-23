import { useEffect, useId, useRef, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  History,
  LoaderCircle,
  MessageSquarePlus,
  Pause,
  Pencil,
  Play,
  Trash2,
  X,
} from "lucide-react";
import type { ExecutionActivity } from "../../../packages/core/src/conversation.js";
import type { InputContinuation } from "../../../packages/core/src/continuation.js";
import type { ExecutionReadScope } from "../../../packages/core/src/execution.js";
import type { ObjectiveControl } from "../../../packages/core/src/objective-control.js";
import type { WorkspaceClient } from "./client.js";
import { applicationCall } from "./application-transport.js";
import { copyText } from "./clipboard-text.js";
import { ComposerOptions } from "./ComposerOptions.js";
import {
  executionActivityScope,
  executionActivityStatus,
  executionActivityThreadAvailable,
} from "./execution-activity.js";
import { ExecutionStatusIcon } from "./ExecutionStatusIcon.js";
import { objectiveDetailStatus } from "./subject-sidebar-model.js";
import { Tooltip } from "./ui/Tooltip.js";
import { useModal } from "./useModal.js";

type Goal = NonNullable<ExecutionActivity["objectives"]>[number];
type Thread = ExecutionActivity["threads"][number];
type View = "reading" | "edit" | "records" | "delete";

export function SubjectObjectiveDialog({
  goal,
  threads,
  client,
  fresh,
  statusFresh = fresh,
  onClose,
  onSelect,
  onSupplement,
}: {
  goal: Goal;
  threads: Thread[];
  client: WorkspaceClient;
  fresh: boolean;
  /** Display freshness never relaxes the independent action guard. */
  statusFresh?: boolean;
  onClose(): void;
  onSelect(scope: ExecutionReadScope): void;
  onSupplement?: (target: InputContinuation) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    body = useRef<HTMLDivElement>(null),
    editor = useRef<HTMLTextAreaElement>(null),
    cancel = useRef<HTMLButtonElement>(null),
    more = useRef<HTMLButtonElement>(null),
    previousView = useRef<View>("reading"),
    pending = useRef(false),
    alive = useRef(true);
  const titleId = useId(),
    descriptionId = useId();
  const [view, setView] = useState<View>("reading");
  const [selected, setSelected] = useState(goal);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<
    ObjectiveControl["action"] | "supplement" | ""
  >("");
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  useModal(dialog, body);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!element || view !== "reading" || busy) return;
    let backdropTouch: number | undefined;
    const outside = (touch: Touch) => {
      const bounds = element.getBoundingClientRect();
      return (
        touch.clientX < bounds.left ||
        touch.clientX > bounds.right ||
        touch.clientY < bounds.top ||
        touch.clientY > bounds.bottom
      );
    };
    const start = (event: TouchEvent) => {
      backdropTouch = undefined;
      if (event.target !== element || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      if (outside(touch)) {
        // Native light-dismiss can close the dialog before this touch's
        // compatibility mouse events. Cancel only those synthesized events,
        // so the same tap cannot activate the work surface underneath.
        event.preventDefault();
        backdropTouch = touch.identifier;
      }
    };
    const cancel = () => {
      backdropTouch = undefined;
    };
    const end = (event: TouchEvent) => {
      const identifier = backdropTouch;
      cancel();
      const touch = Array.from(event.changedTouches).find(
        (point) => point.identifier === identifier,
      );
      if (
        touch &&
        event.touches.length === 0 &&
        outside(touch) &&
        element.open &&
        !pending.current
      ) {
        // Newer engines light-dismiss on click, which start() suppressed.
        // Finish only this unmoved, single-finger backdrop tap through the
        // native cancel/close path. Earlier pointerup-based engines may have
        // closed already; never close twice or replay a compatibility click.
        element.requestClose();
      }
    };
    element.addEventListener("touchstart", start, { passive: false });
    element.addEventListener("touchmove", cancel, { passive: true });
    element.addEventListener("touchcancel", cancel, { passive: true });
    element.addEventListener("touchend", end, { passive: true });
    return () => {
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", cancel);
      element.removeEventListener("touchcancel", cancel);
      element.removeEventListener("touchend", end);
    };
  }, [view, busy]);
  useEffect(() => {
    if (view === "edit") editor.current?.focus();
    else if (view === "delete") cancel.current?.focus();
    else if (view === "records") body.current?.focus();
    else if (previousView.current !== "reading") more.current?.focus();
    previousView.current = view;
  }, [view]);
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(""), 2400);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  const disabled =
    !!busy ||
    !fresh ||
    !client.online ||
    !goal.controlAllowed ||
    !goal.revision;
  const editable = ["active", "paused", "blocked"].includes(goal.status);
  const resumable = ["paused", "blocked"].includes(goal.status);
  // Use the existing, authorized Runtime continuation fence. A related child
  // or a guessed generation must never become a goal's input destination.
  const targets = threads.flatMap((thread) => {
    const target = thread.continuation;
    return thread.sessionId === goal.sessionId &&
      thread.projectId === goal.projectId &&
      thread.conversationId === goal.conversationId &&
      goal.threadIds.includes(thread.id) &&
      target?.mode === "supplement" &&
      target.objective?.id === goal.id &&
      target.objective.generation === goal.generation
      ? [target]
      : [];
  });
  const target = targets.length === 1 ? targets[0] : undefined;
  const supplementDisabled =
    disabled || goal.status !== "active" || !target || !onSupplement;
  const unavailable =
    !fresh || !client.online
      ? "连接恢复后可操作"
      : !goal.controlAllowed
        ? "此目标仅可查看"
        : "";
  function changeView(next: View) {
    setError("");
    setFeedback("");
    if (next === "edit" || next === "delete") {
      setSelected({ ...goal });
      setText(goal.title);
    }
    setView(next);
  }
  async function control(action: ObjectiveControl["action"]) {
    const captured = action === "edit" || action === "delete" ? selected : goal;
    if (
      pending.current ||
      disabled ||
      !captured.revision ||
      !captured.controlAllowed
    )
      return;
    const value = text.trim();
    if (
      action === "edit" &&
      (!value || value.length > 32000 || value === captured.title.trim())
    )
      return;
    pending.current = true;
    setBusy(action);
    setError("");
    let accepted = false;
    try {
      const base = {
        objectiveId: captured.id,
        projectId: captured.projectId,
        conversationId: captured.conversationId,
        revision: captured.revision,
      };
      await applicationCall(
        "objective.control",
        action === "edit"
          ? ({
              ...base,
              action,
              statedObjective: value,
            } satisfies ObjectiveControl)
          : ({ ...base, action } satisfies ObjectiveControl),
      );
      accepted = true;
    } catch (cause) {
      if (alive.current) {
        if (action === "delete") setView("reading");
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
        if (accepted && action === "delete") onClose();
        else if (accepted) {
          setView("reading");
          setFeedback(action === "edit" ? "已保存" : "");
        }
        if (!refreshed && action !== "delete")
          setError("最新状态暂时无法读取，请核对后再操作。");
      }
    }
  }
  async function supplement() {
    if (pending.current || supplementDisabled || !target || !onSupplement)
      return;
    pending.current = true;
    setBusy("supplement");
    setError("");
    try {
      await onSupplement(target);
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "暂时无法关联目标，请稍后再试。",
        );
    } finally {
      pending.current = false;
      if (alive.current) setBusy("");
    }
  }
  async function copy() {
    try {
      await copyText(goal.title);
      if (alive.current) setFeedback("已复制完整目标");
    } catch {
      if (alive.current) setError("复制失败，请选中目标文字后复制。");
    }
  }
  const title = {
    reading: "目标",
    edit: "编辑目标",
    records: "执行记录",
    delete: "删除这个目标？",
  }[view];
  return (
    <dialog
      ref={dialog}
      className="create-dialog subject-objective-dialog"
      aria-labelledby={titleId}
      aria-describedby={
        view === "delete" || view === "edit" ? descriptionId : undefined
      }
      data-view={view}
      data-confirmation={view === "delete"}
      aria-busy={!!busy}
      closedby={view === "reading" && !busy ? "any" : "closerequest"}
      onCancel={(event) => {
        event.stopPropagation();
        if (pending.current || view !== "reading") {
          event.preventDefault();
          if (!pending.current) changeView("reading");
        }
        // Let native light-dismiss complete before React removes the dialog.
        // Backdrop touchstart separately suppresses compatibility mouse events.
      }}
      onClose={onClose}
    >
      <header>
        <div className="subject-objective-dialog-heading">
          <h2 id={titleId}>{title}</h2>
          {view === "reading" && (
            <p className="muted" role="status">
              {feedback ||
                (statusFresh
                  ? objectiveDetailStatus(
                      goal.status,
                      goal.readiness,
                      goal.waitKinds,
                    )
                  : "目标状态暂时无法读取")}
            </p>
          )}
        </div>
        <div
          className="subject-objective-toolbar"
          role="group"
          aria-label="目标操作"
        >
          {view === "reading" ? (
            <>
              <Tooltip
                label={
                  unavailable ||
                  (goal.status !== "active"
                    ? "恢复目标后可补充"
                    : !target || !onSupplement
                      ? "当前没有可接收补充的执行"
                      : "补充目标")
                }
              >
                <button
                  className="icon-button"
                  aria-label="补充目标"
                  disabled={supplementDisabled}
                  onClick={() => void supplement()}
                >
                  {busy === "supplement" ? (
                    <LoaderCircle className="busy-icon" />
                  ) : (
                    <MessageSquarePlus />
                  )}
                </button>
              </Tooltip>
              <Tooltip label="复制完整目标">
                <button
                  className="icon-button"
                  aria-label="复制完整目标"
                  onClick={() => void copy()}
                >
                  <Copy />
                </button>
              </Tooltip>
              <Tooltip label={unavailable || (resumable ? "恢复" : "暂停")}>
                <button
                  className="icon-button"
                  aria-label={resumable ? "恢复" : "暂停"}
                  disabled={disabled || !editable}
                  onClick={() => void control(resumable ? "resume" : "pause")}
                >
                  {busy === "pause" || busy === "resume" ? (
                    <LoaderCircle className="busy-icon" />
                  ) : resumable ? (
                    <Play />
                  ) : (
                    <Pause />
                  )}
                </button>
              </Tooltip>
              <ComposerOptions
                label="更多目标操作"
                menuLabel="目标选项"
                below
                triggerRef={more}
                triggerClassName="icon-button"
                triggerDisabled={!!busy}
                menuClassName="subject-objective-menu"
                options={[
                  {
                    label: "编辑目标",
                    icon: <Pencil />,
                    disabled: disabled || !editable,
                    onSelect: () => changeView("edit"),
                  },
                  {
                    label: "执行记录",
                    icon: <History />,
                    onSelect: () => changeView("records"),
                  },
                  {
                    label: "删除目标",
                    icon: <Trash2 />,
                    disabled: disabled || goal.status === "cancelled",
                    onSelect: () => changeView("delete"),
                  },
                ]}
              />
            </>
          ) : (
            view !== "delete" && (
              <Tooltip label="返回目标">
                <button
                  className="icon-button"
                  aria-label="返回目标"
                  disabled={!!busy}
                  onClick={() => changeView("reading")}
                >
                  <ArrowLeft />
                </button>
              </Tooltip>
            )
          )}
          <Tooltip label="关闭目标">
            <button
              className="icon-button"
              aria-label="关闭目标"
              disabled={!!busy}
              onClick={onClose}
            >
              <X />
            </button>
          </Tooltip>
        </div>
      </header>
      {view === "reading" && (
        <div
          ref={body}
          className="subject-objective-dialog-text"
          role="region"
          aria-label="完整目标"
          tabIndex={0}
        >
          {goal.title
            .split(/(\r?\n+)/)
            .map((part, index) =>
              /^\r?\n/.test(part) ? (
                part
              ) : part ? (
                <p key={index}>{part}</p>
              ) : null,
            )}
        </div>
      )}
      {view === "edit" && (
        <>
          <p id={descriptionId} className="subject-objective-hint">
            修改目标内容，不改变已有执行记录或自动恢复已暂停的目标。
          </p>
          <textarea
            ref={editor}
            className="subject-objective-editor"
            aria-label="目标内容"
            value={text}
            disabled={!!busy}
            maxLength={32000}
            onChange={(event) => setText(event.target.value)}
          />
          {selected.revision !== goal.revision && (
            <p className="subject-objective-hint">
              目标已更新。你的修改仍保留；请返回核对最新目标后再编辑。
            </p>
          )}
        </>
      )}
      {view === "records" && (
        <div
          ref={body}
          className="subject-objective-records"
          role="region"
          aria-label="目标执行记录"
          tabIndex={0}
        >
          {threads.length ? (
            threads.map((thread) => {
              const status = executionActivityStatus(
                thread,
                client.online &&
                  executionActivityThreadAvailable(
                    thread,
                    client.boot!.runtime,
                  ),
              );
              return (
                <button
                  key={thread.id}
                  className="subject-objective-record"
                  onClick={() => {
                    onClose();
                    onSelect(
                      executionActivityScope(thread, client.boot!.workspace),
                    );
                  }}
                >
                  <ExecutionStatusIcon kind={status.kind} size={18} />
                  <span>
                    <strong>{thread.title}</strong>
                    <small>{status.label}</small>
                  </span>
                  <ChevronRight />
                </button>
              );
            })
          ) : (
            <p className="muted">当前概览中暂无关联执行记录。</p>
          )}
          {client.boot!.runtime.activity?.truncated && (
            <p className="subject-objective-hint">
              这里只列出当前已读取的关联执行，不代表完整历史。
            </p>
          )}
        </div>
      )}
      {view === "delete" && (
        <p id={descriptionId} className="subject-objective-delete-warning">
          删除会停止目标的自动推进。已有内容和执行记录会保留，已发生的操作不会撤回。
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {(view === "delete" || view === "edit") && (
        <footer
          role="group"
          aria-label={view === "delete" ? "删除目标确认" : "编辑目标操作"}
        >
          <button
            ref={cancel}
            className="secondary-action"
            disabled={!!busy}
            onClick={() => changeView("reading")}
          >
            {view === "delete" ? "保留目标" : "取消"}
          </button>
          <button
            className={`primary${view === "delete" ? " danger" : ""}`}
            disabled={
              disabled ||
              (view === "edit" &&
                (!text.trim() ||
                  text.trim() === selected.title.trim() ||
                  selected.revision !== goal.revision))
            }
            onClick={() => void control(view === "delete" ? "delete" : "edit")}
          >
            {busy
              ? busy === "delete"
                ? "删除中…"
                : "保存中…"
              : view === "delete"
                ? "确认删除"
                : "保存修改"}
          </button>
        </footer>
      )}
    </dialog>
  );
}
