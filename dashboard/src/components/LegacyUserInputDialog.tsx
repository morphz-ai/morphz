import { useId } from "react";
import { LoaderCircle, MessageSquarePlus, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import "./user-input-dialog.css";

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
  const { t } = useTranslation();
  const inputId = useId();
  const canSend = !busy && (frozen || (available && !!body.trim()));
  return (
    <section
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
          <span className="runtime-question-target" title={title}>{t("steering.supplement")} · {title}</span>
          <button
            type="button"
            title={t("userInput.close")}
            aria-label={t("userInput.close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="runtime-question-body">
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
    </section>
  );
}
