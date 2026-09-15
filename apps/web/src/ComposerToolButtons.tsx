import type { ReactNode } from "react";

type Tool = {
  id?: string;
  label: string;
  icon: ReactNode;
  onSelect(): void;
  disabled?: boolean;
  title?: string;
  pressed?: boolean;
  groupStart?: boolean;
  reserveOnly?: boolean;
};

/** Direct input actions. Stable keys preserve focus when a toggle changes label. */
export function ComposerToolButtons({
  options,
  unread,
}: {
  options: Tool[];
  unread?: boolean;
}) {
  return options.map((option) => (
    <button
      key={option.id ?? option.label}
      className={
        "icon-button composer-tool" +
        (option.groupStart ? " composer-tool-group-start" : "") +
        (option.reserveOnly ? " composer-tool-reserved" : "")
      }
      aria-label={option.label}
      aria-hidden={option.reserveOnly || undefined}
      aria-pressed={option.pressed}
      aria-description={
        unread && option.id === "history-visibility" ? "有新回复" : undefined
      }
      title={option.title ?? option.label}
      disabled={option.disabled || option.reserveOnly}
      onClick={option.onSelect}
    >
      {option.icon}
      {unread && option.id === "history-visibility" && (
        <span className="composer-unread" aria-hidden="true" />
      )}
    </button>
  ));
}
