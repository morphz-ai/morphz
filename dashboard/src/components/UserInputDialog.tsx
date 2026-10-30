import { useEffect, useId, useRef } from "react";
import {
  ArrowUp,
  Check,
  LoaderCircle,
  MessageSquarePlus,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  userInputAnswerText,
  type PendingUserInputRequest,
  type UserInputAnswer,
} from "../../../sdk/typescript/src/user-input.ts";
import "./user-input-dialog.css";

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
}: {
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
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  const titleId = useId(),
    feedbackId = useId();
  const focused = useRef(false);
  useEffect(() => {
    if (busy || !available || focused.current) return;
    focused.current = true;
    if (!panel.current?.contains(document.activeElement))
      panel.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }, [available, busy]);
  const text = userInputAnswerText(request.questions, answers);
  const canSend =
    !busy && (frozen || (available && text !== null && text.length <= 30000));
  const singleQuestion = request.questions.length === 1;
  const sendLabel = t(
    busy
      ? "userInput.sending"
      : frozen
        ? "userInput.recheck"
        : "userInput.send",
  );
  const send = (
    <button
      type="submit"
      className={`question-send runtime-question-send${frozen ? " is-recheck" : ""}`}
      disabled={!canSend}
      aria-label={sendLabel}
      title={sendLabel}
      aria-describedby={error ? feedbackId : undefined}
    >
      {busy ? (
        <LoaderCircle size={16} className="spin" aria-hidden="true" />
      ) : (
        <ArrowUp size={18} aria-hidden="true" />
      )}
      {frozen && <span>{t("userInput.recheck")}</span>}
    </button>
  );
  function change(
    id: string,
    patch: Partial<UserInputAnswer>,
    selection = false,
  ) {
    if (!available || busy || frozen) return;
    const next = answers.map((answer) =>
      answer.question_id === id ? { ...answer, ...patch } : answer,
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
      className="composer-question runtime-question-composer"
      data-single-question={singleQuestion || undefined}
      aria-label={t("userInput.title")}
      aria-busy={busy}
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
          <span className="runtime-question-target" tabIndex={0} title={title}>
            {t("steering.supplement")} · {title}
          </span>
          <button
            type="button"
            aria-label={t("userInput.close")}
            title={t("userInput.close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="runtime-question-body">
          {request.questions.map((question, index) => {
            const answer = answers.find(
              (value) => value.question_id === question.id,
            );
            const textId = `${titleId}-text-${index}`;
            const inputLabel = t(
              question.options?.length ? "userInput.extra" : "userInput.answer",
            );
            return (
              <fieldset
                key={question.id}
                disabled={busy || (!available && !frozen)}
              >
                <legend>{question.question}</legend>
                {(question.options ?? []).map((option, ordinal) => {
                  const selected =
                    answer?.selected_option_ids.includes(option.id) ?? false;
                  return (
                    <label
                      className="runtime-question-choice"
                      data-selected={selected || undefined}
                      data-multiple={question.multi_select || undefined}
                      key={option.id}
                    >
                      <span
                        className="runtime-question-number"
                        aria-hidden="true"
                      >
                        {selected && !question.multi_select ? (
                          <Check size={13} />
                        ) : (
                          ordinal + 1
                        )}
                      </span>
                      <span>
                        <span>{option.label}</span>
                        {option.description && (
                          <small>{option.description}</small>
                        )}
                      </span>
                      <input
                        type={question.multi_select ? "checkbox" : "radio"}
                        name={`${titleId}-${question.id}`}
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
                                      ...(answer?.selected_option_ids ?? []),
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
                <div className="runtime-question-text-label">
                  <label className="question-input-label" htmlFor={textId}>
                    {inputLabel}
                  </label>
                  {!!answer?.selected_option_ids.length && (
                    <button
                      type="button"
                      disabled={frozen}
                      onClick={() =>
                        change(question.id, { selected_option_ids: [] })
                      }
                    >
                      {t("userInput.clear")}
                    </button>
                  )}
                </div>
                <div className="question-answer-row">
                  <textarea
                    id={textId}
                    rows={1}
                    placeholder={t(
                      question.options?.length
                        ? "userInput.extraPlaceholder"
                        : "userInput.answerPlaceholder",
                    )}
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
          <div id={feedbackId} aria-live="polite">
            {error ? (
              <p role="alert">{error}</p>
            ) : (status ??
              (!available && !frozen
                ? t("userInput.stale")
                : text && text.length > 30000
                  ? t("userInput.tooLong")
                  : "")) ? (
              <p>
                {status ??
                  (!available && !frozen
                    ? t("userInput.stale")
                    : t("userInput.tooLong"))}
              </p>
            ) : null}
            {frozen && <p>{t("userInput.receiptRetained")}</p>}
          </div>
          {!singleQuestion && send}
        </footer>
      </form>
    </section>
  );
}
