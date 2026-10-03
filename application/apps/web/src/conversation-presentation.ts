import type { ConversationRuntime } from "../../../packages/core/src/conversation.js";

type ResponseDelivery = Readonly<
  Pick<
    ConversationRuntime["deliveries"][number],
    "state" | "error" | "supplement"
  >
>;

/** Observable waiting only: callers retain exact input/stream ownership and
 * their cancellation policy. This is neither a reply nor execution evidence. */
export function isPendingResponse({
  configured,
  delivery,
  answered,
  approvalPending,
}: Readonly<{
  configured: boolean;
  delivery: ResponseDelivery | undefined;
  answered: boolean;
  approvalPending: boolean;
}>): boolean {
  return (
    configured &&
    !!delivery &&
    !delivery.supplement &&
    !delivery.error &&
    ["queued", "sending", "running"].includes(delivery.state) &&
    !answered &&
    !approvalPending
  );
}

const dateLabel = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "long",
  day: "numeric",
  weekday: "short",
});

/** Calendar boundaries follow the reader's local time, like message timestamps. */
export function conversationDate(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  const key = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
  return {
    key,
    label: dateLabel.format(date),
  };
}
