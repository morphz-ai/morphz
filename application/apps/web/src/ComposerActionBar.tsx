import type { ReactNode } from "react";
import "./composer-compact.css";

/** One row, even in narrow windows. Details belong to the invoked menus. */
export function ComposerActionBar({
  media,
  scope,
  settings,
  microphone,
  send,
}: {
  media: ReactNode;
  scope?: ReactNode;
  settings?: ReactNode;
  microphone: ReactNode;
  send: ReactNode;
}) {
  return (
    <div className="composer-actions composer-action-bar">
      <div className="composer-action-leading">
        {media}
        {scope}
      </div>
      <div className="composer-action-trailing">
        {settings}
        {microphone}
        {send}
      </div>
    </div>
  );
}
