import { useEffect, useId, useLayoutEffect, useRef } from "react";
import {
  ArrowUp,
  Check,
  LoaderCircle,
  MessageSquarePlus,
  X,
} from "lucide-react";
import type {
  PendingUserInputRequest,
  UserInputAnswer,
} from "../../../packages/core/src/user-input.js";
import { userInputAnswerText } from "../../../packages/core/src/user-input.js";
import { Tooltip } from "./ui/Tooltip.js";
import "./user-input-dialog.css";

export type UserInputDialogProps = {
  title: string;
  request: PendingUserInputRequest;
  answers: UserInputAnswer[];
  available: boolean;
  busy: boolean;
  frozen: boolean;
  error?: string;
  status?: string;
  onChange(answers: UserInputAnswer[]): void;
  onSubmit(answers?: UserInputAnswer[]): void;
  onClose(): void;
};

/** A complete single-choice reply submits on selection. Multi-select and free
 * text retain explicit submission; dismissing never consumes the request. */
export function UserInputDialog({
  title,
  request,
  answers,
  available,
  busy,
  frozen,
  error,
  status,
  onChange,
  onSubmit,
  onClose,
}: UserInputDialogProps) {
  const panel = useRef<HTMLElement>(null),
    body = useRef<HTMLDivElement>(null);
  const titleId = useId(),
    statusId = useId();
  const focused = useRef(false);
  useLayoutEffect(() => {
    // The ordinary input is hidden during an async question read. Keep focus
    // inside the existing exchange so its leave guard cannot collapse it.
    panel.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    if (busy || !available || focused.current) return;
    focused.current = true;
    if (
      document.activeElement === panel.current ||
      !panel.current?.contains(document.activeElement)
    )
      panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [available, busy]);
  const answerText = userInputAnswerText(request.questions, answers);
  const canSend =
    !busy &&
    (frozen ||
      (available && answerText !== null && answerText.length <= 30000));
  const singleQuestion = request.questions.length === 1;
  const send = (
    <button
      type="submit"
      className={`question-send${frozen ? " is-recheck" : ""}`}
      disabled={!canSend}
      aria-label={busy ? "发送中" : frozen ? "核对投递" : "发送"}
      title={busy ? "发送中" : frozen ? "核对投递" : "发送"}
      aria-describedby={error ? statusId : undefined}
    >
      {busy ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <ArrowUp size={18} aria-hidden="true" />
      )}
      {frozen && <span>核对投递</span>}
    </button>
  );
  function change(
    questionId: string,
    patch: Partial<UserInputAnswer>,
    selection = false,
  ) {
    if (busy || frozen || !available) return;
    const next = answers.map((answer) =>
      answer.question_id === questionId ? { ...answer, ...patch } : answer,
    );
    onChange(next);
    const text =
      selection && !request.questions.some((question) => question.multi_select)
        ? userInputAnswerText(request.questions, next)
        : null;
    if (text !== null && text.length <= 30000) onSubmit(next);
  }
  return (
    <section
      ref={panel}
      className="composer-question user-input-composer"
      data-single-question={singleQuestion || undefined}
      aria-label="补充问题"
      aria-busy={busy}
      tabIndex={-1}
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
          if (canSend) onSubmit();
        }
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        <header>
          <MessageSquarePlus size={16} aria-hidden="true" />
          <span
            className="user-input-composer-target"
            tabIndex={0}
            title={title}
          >
            补充给：{title}
          </span>
          <Tooltip label="关闭，稍后回复">
            <button
              type="button"
              className="icon-button"
              aria-label="关闭，稍后回复"
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        <div className="user-input-composer-body" ref={body}>
          {request.questions.map((question, index) => {
            const options = question.options ?? [];
            const answer = answers.find(
              (value) => value.question_id === question.id,
            );
            const textId = `${titleId}-answer-${index}`;
            const inputLabel = options.length
              ? "补充说明，或直接填写答案"
              : "你的回复";
            return (
              <fieldset
                key={question.id}
                disabled={busy || (!available && !frozen)}
              >
                <legend>{question.question}</legend>
                {!!options.length && (
                  <div className="user-input-choices">
                    {options.map((option, ordinal) => {
                      const selected =
                        answer?.selected_option_ids.includes(option.id) ??
                        false;
                      return (
                        <label
                          key={option.id}
                          className="user-input-choice"
                          data-selected={selected || undefined}
                          data-multiple={question.multi_select || undefined}
                        >
                          <span
                            className="user-input-choice-number"
                            aria-hidden="true"
                          >
                            {selected && !question.multi_select ? (
                              <Check size={13} />
                            ) : (
                              ordinal + 1
                            )}
                          </span>
                          <span className="user-input-choice-copy">
                            <span>{option.label}</span>
                            {option.description && (
                              <small>{option.description}</small>
                            )}
                          </span>
                          <input
                            type={question.multi_select ? "checkbox" : "radio"}
                            name={`${titleId}-${question.id}`}
                            value={option.id}
                            checked={selected}
                            disabled={frozen}
                            onChange={() =>
                              change(
                                question.id,
                                {
                                  selected_option_ids: question.multi_select
                                    ? selected
                                      ? answer!.selected_option_ids.filter(
                                          (id) => id !== option.id,
                                        )
                                      : [
                                          ...(answer?.selected_option_ids ??
                                            []),
                                          option.id,
                                        ]
                                    : [option.id],
                                },
                                !question.multi_select,
                              )
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="user-input-text-heading">
                  <label
                    className="user-input-text-label question-input-label"
                    htmlFor={textId}
                  >
                    {inputLabel}
                  </label>
                  {!!answer?.selected_option_ids.length && (
                    <button
                      type="button"
                      className="user-input-clear"
                      disabled={frozen}
                      onClick={() =>
                        change(question.id, { selected_option_ids: [] })
                      }
                    >
                      取消选择
                    </button>
                  )}
                </div>
                <div className="question-answer-row">
                  <textarea
                    id={textId}
                    rows={1}
                    placeholder={options.length ? "补充回答…" : "输入回答…"}
                    maxLength={8000}
                    value={answer?.text ?? ""}
                    disabled={frozen}
                    onChange={(event) =>
                      change(question.id, { text: event.target.value })
                    }
                  />
                  {singleQuestion && send}
                </div>
              </fieldset>
            );
          })}
        </div>
        <footer>
          <div id={statusId} className="user-input-feedback" aria-live="polite">
            {error ? (
              <p role="alert">{error}</p>
            ) : status ? (
              <p>{status}</p>
            ) : !available && !frozen ? (
              <p>问题已不再待答，或当前状态尚未确认。输入已保留。</p>
            ) : answerText && answerText.length > 30000 ? (
              <p>回复过长，请缩短后发送。</p>
            ) : null}
          </div>
          {!singleQuestion && send}
        </footer>
      </form>
    </section>
  );
}
