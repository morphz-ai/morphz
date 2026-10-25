import { Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import { currentQuestion } from "../app/userInput";
import type { SchedulerThreadSnapshot } from "../scheduler/types";
import "./user-input-dialog.css";

export function UserInputPreview({
  snapshot,
  onReply,
}: {
  snapshot: SchedulerThreadSnapshot;
  onReply?: (snapshot: SchedulerThreadSnapshot) => void;
}) {
  const { t } = useTranslation();
  const question = currentQuestion(snapshot);
  if (!question || !onReply) return null;
  const action = t(
    snapshot.thread.control_state === "paused" || question.reply_allowed === false
      ? "userInput.view"
      : "userInput.reply",
  );
  return (
    <div className="runtime-question-preview" role="group" aria-label={t("userInput.title")}>
        <button className="runtime-question-reply" type="button" title={action} aria-label={action} aria-haspopup="dialog" onClick={() => onReply(snapshot)}>
          <Reply size={14} aria-hidden="true" />
          {action}
        </button>
    </div>
  );
}
