import { useId, useRef } from "react";
import { MessageCircleQuestion, Send, X, LoaderCircle } from "lucide-react";
import { useModal } from "./useModal.js";
import "./user-input-dialog.css";

/** Legacy waits did not save a question body. Say so instead of constructing
 * a question from progress or guessing which task the person meant. */
export function LegacyUserInputDialog({
  title,
  value,
  available,
  reading,
  busy,
  frozen,
  error,
  legacy = true,
  onChange,
  onSubmit,
  onClose,
}: {
  title: string;
  value: string;
  available: boolean;
  reading: boolean;
  busy: boolean;
  frozen: boolean;
  error?: string;
  legacy?: boolean;
  onChange(value: string): void;
  onSubmit(): void;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    body = useRef<HTMLDivElement>(null);
  const titleId = useId(),
    inputId = useId();
  useModal(dialog, body);
  return (
    <dialog
      ref={dialog}
      className="create-dialog user-input-dialog"
      aria-labelledby={titleId}
      closedby="any"
      onClose={onClose}
      aria-busy={reading || busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!reading && !busy && (frozen || (available && value.trim())))
            onSubmit();
        }}
      >
        <header>
          <MessageCircleQuestion size={18} aria-hidden="true" />
          <h2 id={titleId}>问题</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭，稍后回复"
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </header>
        <div className="user-input-dialog-body" ref={body} tabIndex={-1}>
          <p className="user-input-task">{title}</p>
          <p>
            {reading
              ? "正在确认待答问题…"
              : legacy
                ? "旧记录没有保存具体问题。请根据原任务填写回复，不会转交给其他线程。"
                : "暂时无法读取这个问题，输入未发送。"}
          </p>
          {!reading && (
            <>
              <label className="user-input-text-label" htmlFor={inputId}>
                你的回复
              </label>
              <textarea
                id={inputId}
                rows={3}
                maxLength={8000}
                value={value}
                disabled={!available || busy || frozen}
                onChange={(event) => onChange(event.target.value)}
              />
            </>
          )}
        </div>
        <footer>
          <div className="user-input-feedback" aria-live="polite">
            {error && <p role="alert">{error}</p>}
          </div>
          <button
            type="submit"
            className="primary"
            disabled={
              reading || busy || (!frozen && (!available || !value.trim()))
            }
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Send size={15} />
            )}
            {busy ? "发送中" : frozen ? "核对投递" : "发送"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
