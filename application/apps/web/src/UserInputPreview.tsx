import { Reply } from "lucide-react";
import type { ActivityThread } from "./execution-activity.js";
import "./user-input-dialog.css";

export function UserInputPreview({
  thread,
  disabled,
  onReply,
}: {
  thread: ActivityThread;
  disabled?: boolean;
  onReply?: (thread: ActivityThread) => void;
}) {
  const request = thread.userInputRequest;
  if (!request || !onReply || !thread.continuation) return null;
  const action =
    thread.controlState === "paused" || request.reply_allowed === false
      ? "查看问题"
      : "回答问题";
  return (
    <div
      className="user-input-preview"
      data-request-id={request.request_id}
      role="group"
      aria-label="待答问题"
    >
        <button
          className="user-input-reply"
          type="button"
          disabled={disabled}
          title={action}
          aria-label={action}
          aria-haspopup="dialog"
          onClick={() => onReply(thread)}
        >
          <Reply size={16} aria-hidden="true" />
          {action}
        </button>
    </div>
  );
}
