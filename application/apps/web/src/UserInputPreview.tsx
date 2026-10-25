import { MessageSquarePlus } from "lucide-react";
import type { ActivityThread } from "./execution-activity.js";
import "./user-input-dialog.css";
import { observeSupplementAttention } from "./supplement-attention.js";

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
  return (
    <div
      className="user-input-preview"
      data-request-id={request.request_id}
      role="group"
      aria-label="待答问题"
    >
      <button
        ref={observeSupplementAttention}
        className="icon-button user-input-reply needs-input"
        type="button"
        disabled={disabled}
        title="补充 · 有待答问题"
        aria-label="补充"
        aria-controls="global-composer"
        onClick={() => onReply(thread)}
      >
        <MessageSquarePlus size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
