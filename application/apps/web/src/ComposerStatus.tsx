import type { ReactNode } from "react";
import { CircleAlert } from "lucide-react";
import { ComposerOptions } from "./ComposerOptions.js";

/** A notice shares the input tools row; full details never grow the draft. */
export function ComposerStatus({
  error,
  children,
}: {
  error?: string;
  children?: ReactNode;
}) {
  if (!error && !children) return null;
  return (
    <div className="composer-status-slot">
      {error ? (
        <ComposerOptions
          options={[]}
          label="输入错误详情"
          description={error}
          menuLabel="输入错误详情"
          triggerClassName="composer-error-notice"
          menuClassName="composer-error-details"
          align="start"
          initialFocus="panel"
          triggerIcon={
            <>
              <CircleAlert aria-hidden="true" />
              <span className="composer-error" role="alert">
                {error}
              </span>
            </>
          }
          content={() => (
            <>
              <p>{error}</p>
              {children}
            </>
          )}
        />
      ) : (
        children
      )}
    </div>
  );
}
