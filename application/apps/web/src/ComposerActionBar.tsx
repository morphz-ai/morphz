import type { ReactNode } from "react";
import "./composer-compact.css";

/** One row, even in narrow windows. Details belong to the invoked menus. */
export function ComposerActionBar({
  media,
  scope,
  status,
  capacity,
  settings,
  microphone,
  send,
}: {
  media: ReactNode;
  scope?: ReactNode;
  status?: ReactNode;
  capacity?: ReactNode;
  settings?: ReactNode;
  microphone: ReactNode;
  send: ReactNode;
}) {
  return (
    <div className="composer-actions composer-action-bar">
      <div className="composer-action-leading">
        {media}
        {scope}
        {status}
      </div>
      <div className="composer-action-trailing">
        {capacity}
        {settings}
        {microphone}
        {send}
      </div>
    </div>
  );
}
