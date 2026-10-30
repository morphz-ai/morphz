import { useId, useRef } from "react";
import { MessageSquarePlus, Send, X, LoaderCircle } from "lucide-react";
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
  const body = useRef<HTMLDivElement>(null);
  const inputId = useId();
  return (
    <section
      className="composer-question user-input-composer"
      aria-label="补充问题"
      aria-busy={reading || busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (
          event.target instanceof HTMLTextAreaElement &&
          event.key === "Enter" &&
          !event.shiftKey &&
          !event.nativeEvent.isComposing &&
          event.nativeEvent.keyCode !== 229
        ) {
          event.preventDefault();
          if (!reading && !busy && (frozen || (available && value.trim())))
            onSubmit();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!reading && !busy && (frozen || (available && value.trim())))
            onSubmit();
        }}
      >
        <header>
          <MessageSquarePlus size={16} aria-hidden="true" />
          <span className="user-input-composer-target" title={title}>
            补充给：{title}
          </span>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭，稍后回复"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="user-input-composer-body" ref={body}>
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
    </section>
  );
}
