import { useId, useRef } from "react";
import { LoaderCircle, MessageCircleQuestion, Send, X } from "lucide-react";
import type {
  PendingUserInputRequest,
  UserInputAnswer,
} from "../../../packages/core/src/user-input.js";
import { userInputAnswerText } from "../../../packages/core/src/user-input.js";
import { useModal } from "./useModal.js";
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
  onSubmit(): void;
  onClose(): void;
};

/** A selection is only a form edit. Native form submission is the sole answer
 * action; dismissing never consumes the Runtime request or the main draft. */
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
  const dialog = useRef<HTMLDialogElement>(null),
    body = useRef<HTMLDivElement>(null);
  const titleId = useId(),
    taskId = useId(),
    statusId = useId();
  useModal(dialog, body);
  const answerText = userInputAnswerText(request.questions, answers);
  const canSend =
    !busy &&
    (frozen ||
      (available && answerText !== null && answerText.length <= 30000));
  function change(questionId: string, patch: Partial<UserInputAnswer>) {
    if (busy || frozen || !available) return;
    onChange(
      answers.map((answer) =>
        answer.question_id === questionId ? { ...answer, ...patch } : answer,
      ),
    );
  }
  return (
    <dialog
      ref={dialog}
      className="create-dialog user-input-dialog"
      aria-labelledby={titleId}
      aria-busy={busy}
      closedby="any"
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        <header>
          <MessageCircleQuestion size={18} aria-hidden="true" />
          <h2 id={titleId}>问题</h2>
          <Tooltip label="关闭，稍后回复">
            <button
              type="button"
              className="icon-button"
              aria-label="关闭，稍后回复"
              onClick={() => dialog.current?.close()}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </Tooltip>
        </header>
        <div className="user-input-dialog-body" ref={body} tabIndex={-1}>
          {request.questions.map((question, index) => {
            const options = question.options ?? [];
            const answer = answers.find(
              (value) => value.question_id === question.id,
            );
            const textId = `${titleId}-answer-${index}`;
            return (
              <fieldset
                key={question.id}
                disabled={busy || frozen || !available}
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
                        >
                          <span
                            className="user-input-choice-number"
                            aria-hidden="true"
                          >
                            {ordinal + 1}
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
                            onChange={() =>
                              change(question.id, {
                                selected_option_ids: question.multi_select
                                  ? selected
                                    ? answer!.selected_option_ids.filter(
                                        (id) => id !== option.id,
                                      )
                                    : [
                                        ...(answer?.selected_option_ids ?? []),
                                        option.id,
                                      ]
                                  : [option.id],
                              })
                            }
                          />
                        </label>
                      );
                    })}
                  </div>
                )}
                <div className="user-input-text-heading">
                  <label className="user-input-text-label" htmlFor={textId}>
                    {options.length ? "补充说明，或直接填写答案" : "你的回复"}
                  </label>
                  {!!answer?.selected_option_ids.length && (
                    <button
                      type="button"
                      className="user-input-clear"
                      onClick={() =>
                        change(question.id, { selected_option_ids: [] })
                      }
                    >
                      取消选择
                    </button>
                  )}
                </div>
                <textarea
                  id={textId}
                  rows={2}
                  maxLength={8000}
                  value={answer?.text ?? ""}
                  onChange={(event) =>
                    change(question.id, { text: event.target.value })
                  }
                />
              </fieldset>
            );
          })}
          <details className="user-input-task">
            <summary id={taskId} title={title}>
              <span>来自</span>
              <span>{title}</span>
            </summary>
            <p>{title}</p>
          </details>
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
          <button
            type="submit"
            className="primary"
            disabled={!canSend}
            aria-describedby={error ? statusId : undefined}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : (
              <Send size={15} aria-hidden="true" />
            )}
            {busy ? "发送中" : frozen ? "核对投递" : "发送"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
