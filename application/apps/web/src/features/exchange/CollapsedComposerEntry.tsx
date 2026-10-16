import type { Ref } from "react";
import {
  CircleAlert,
  MessageCircle,
  Pause,
  ShieldAlert,
  Unplug,
} from "lucide-react";
import type { CollapsedComposerState } from "./collapsed-composer-state.js";
import "./composer-collapsed-entry.css";

export function CollapsedComposerEntry({
  buttonRef,
  agentName,
  shortcut,
  state,
  onOpen,
  allowMotion,
  unseenReply = false,
}: {
  buttonRef?: Ref<HTMLButtonElement>;
  agentName: string;
  shortcut: string;
  state: CollapsedComposerState;
  onOpen: () => void;
  allowMotion: boolean;
  unseenReply?: boolean;
}) {
  const active = state.kind !== "idle";
  const Icon =
    state.kind === "approval"
      ? ShieldAlert
      : state.kind === "offline"
        ? Unplug
        : state.kind === "error"
          ? CircleAlert
          : state.kind === "paused"
            ? Pause
            : MessageCircle;
  const status =
    state.label + (state.count > 1 ? ` · ${state.count} 项工作` : "");
  return (
    <button
      ref={buttonRef}
      type="button"
      className="composer-reopen"
      aria-controls="global-composer"
      aria-expanded={false}
      aria-label={`向 ${agentName} 输入${active ? ` · ${status}` : ""}${unseenReply && state.kind !== "unread" ? " · 有新回复" : ""}`}
      title={
        active
          ? `${status}${state.detail ? `\n${state.detail}` : ""}\n点击展开输入`
          : `向 ${agentName} 输入`
      }
      data-state={state.kind}
      data-animated={(allowMotion && state.animated) || undefined}
      onClick={onOpen}
    >
      <span className="composer-entry-symbol" aria-hidden="true">
        {state.animated ? (
          <span className="composer-entry-pulse">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <Icon />
        )}
      </span>
      <span className="composer-entry-copy">
        {active ? (
          <>
            <span
              className="composer-entry-heading"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              <span className="composer-entry-label">
                {agentName} · {status}
              </span>
              {unseenReply && state.kind !== "unread" && (
                <span className="composer-entry-unread" aria-hidden="true">
                  新回复
                </span>
              )}
            </span>
            {state.detail && (
              <span className="composer-entry-detail">{state.detail}</span>
            )}
          </>
        ) : (
          <span>向 {agentName} 输入</span>
        )}
      </span>
      <kbd>{shortcut}</kbd>
    </button>
  );
}
