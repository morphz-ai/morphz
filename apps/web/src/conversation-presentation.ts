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
