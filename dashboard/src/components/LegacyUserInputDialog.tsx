import { useId, useRef } from "react";
import { LoaderCircle, MessageCircleQuestion, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./user-input-dialog.css";
import { useQuestionDialog } from "./useQuestionDialog";

export function LegacyUserInputDialog({
  title,
  body,
  busy,
  available,
  frozen,
  error,
  onChange,
  onSubmit,
  onClose,
}: {
  title: string;
  body: string;
  busy: boolean;
  available: boolean;
  frozen: boolean;
  error?: string;
  onChange(body: string): void;
  onSubmit(): void;
  onClose(): void;
}) {
  const { t } = useTranslation(),
    dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId(),
    inputId = useId();
  useQuestionDialog(dialog);
  const canSend = !busy && (frozen || (available && !!body.trim()));
  return (
    <dialog
      ref={dialog}
      className="runtime-question-dialog"
      closedby="any"
      aria-labelledby={titleId}
      onClose={onClose}
      aria-busy={busy}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSubmit();
        }}
      >
        <header>
          <MessageCircleQuestion size={18} />
          <h2 id={titleId}>{t("userInput.title")}</h2>
          <button
            type="button"
            title={t("userInput.close")}
            aria-label={t("userInput.close")}
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </header>
        <div className="runtime-question-body">
          <p className="runtime-question-task">{title}</p>
          <p>{t("userInput.legacy")}</p>
          <label className="runtime-question-text-label" htmlFor={inputId}>
            {t("userInput.answer")}
          </label>
          <textarea
            id={inputId}
            rows={3}
            maxLength={8000}
            value={body}
            disabled={!available || busy || frozen}
            onChange={(event) => onChange(event.target.value)}
          />
        </div>
        <footer>
          <div aria-live="polite">
            {error && <p role="alert">{error}</p>}
            {frozen && <p>{t("userInput.receiptRetained")}</p>}
          </div>
          <button
            type="submit"
            className="runtime-question-send"
            disabled={!canSend}
          >
            {busy ? (
              <LoaderCircle className="spin" size={15} />
            ) : (
              <Send size={15} />
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
    </dialog>
  );
}
