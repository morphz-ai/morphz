import { MessageSquarePlus } from "lucide-react";
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
  return (
    <div className="runtime-question-preview" role="group" aria-label={t("userInput.title")}>
        <button className="runtime-question-reply needs-input" type="button" title={t("steering.objectiveReplyHint")} aria-label={t("steering.supplement")} aria-controls="dashboard-composer" onClick={() => onReply(snapshot)}>
          <MessageSquarePlus size={14} aria-hidden="true" />
        </button>
    </div>
  );
}
