import { useEffect, useId, useRef } from "react";
import { LoaderCircle, MessageSquarePlus, Send, X } from "lucide-react";
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
  onSubmit(): void;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const panel = useRef<HTMLElement>(null);
  const titleId = useId(), feedbackId = useId();
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
  function change(id: string, patch: Partial<UserInputAnswer>) {
    if (!available || busy || frozen) return;
    onChange(
      answers.map((answer) =>
        answer.question_id === id ? { ...answer, ...patch } : answer,
      ),
    );
  }
  return (
    <section
      ref={panel}
      className="composer-question runtime-question-composer"
      aria-label={t("userInput.title")}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); onClose(); }
        else if (event.target instanceof HTMLTextAreaElement && event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
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
          <span className="runtime-question-target" tabIndex={0} title={title}>{t("steering.supplement")} · {title}</span>
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
            return (
              <fieldset
                key={question.id}
                disabled={!available || busy || frozen}
              >
                <legend>{question.question}</legend>
                {(question.options ?? []).map((option, ordinal) => {
                  const selected =
                    answer?.selected_option_ids.includes(option.id) ?? false;
                  return (
                    <label
                      className="runtime-question-choice"
                      data-selected={selected || undefined}
                      key={option.id}
                    >
                      <span
                        className="runtime-question-number"
                        aria-hidden="true"
                      >
                        {ordinal + 1}
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
                <div className="runtime-question-text-label">
                  <label htmlFor={textId}>
                    {t(
                      question.options?.length
                        ? "userInput.extra"
                        : "userInput.answer",
                    )}
                  </label>
                  {!!answer?.selected_option_ids.length && (
                    <button
                      type="button"
                      onClick={() =>
                        change(question.id, { selected_option_ids: [] })
                      }
                    >
                      {t("userInput.clear")}
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
        </div>
        <footer>
          <div id={feedbackId} aria-live="polite">
            {error ? (
              <p role="alert">{error}</p>
            ) : (
              <p>
                {status ??
                  (!available && !frozen
                    ? t("userInput.stale")
                    : text && text.length > 30000
                      ? t("userInput.tooLong")
                      : "")}
              </p>
            )}
            {frozen && <p>{t("userInput.receiptRetained")}</p>}
          </div>
          <button
            type="submit"
            className="runtime-question-send"
            disabled={!canSend}
            aria-describedby={error ? feedbackId : undefined}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : (
              <Send size={15} aria-hidden="true" />
            )}
            {t(
              busy
                ? "userInput.sending"
                : frozen
                  ? "userInput.recheck"
                  : "userInput.send",
            )}
          </button>
        </footer>
      </form>
    </section>
  );
}
