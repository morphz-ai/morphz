import type { ControlIconForRole } from "./design/control-icons.js";
import { IconButton } from "./ui/IconButton.js";

export type ComposerTool = {
  id?: string;
  label: string;
  iconId: ControlIconForRole<"exchange-operation">;
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
  options: ComposerTool[];
  unread?: boolean;
}) {
  return options.map((option) => (
    <IconButton
      key={option.id ?? option.label}
      controlRole="exchange-operation"
      iconId={option.iconId}
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
      afterIcon={
        unread &&
        option.id === "history-visibility" && (
          <span className="composer-unread" aria-hidden="true" />
        )
      }
    />
  ));
}
