import { useEffect, useRef, useState } from "react";

/** A selected pane may retain its last visible value while the same route is
 * refreshed. A different book/item/pane can never inherit that value. The
 * reader itself rechecks identity/authorization before returning. */
export function useScriptEditorRead<T>(
  scope: string,
  revision: string | number,
  read: () => Promise<T>,
  enabled = true,
) {
  const reader = useRef(read);
  reader.current = read;
  const [result, setResult] = useState<{
    scope: string;
    revision: string | number;
    value: T;
  }>();
  const [error, setError] = useState<{ scope: string; message: string }>();
  const [pending, setPending] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setPending(true);
    setError(undefined);
    void reader
      .current()
      .then(
        (value) => {
          if (!cancelled) setResult({ scope, revision, value });
        },
        (error: unknown) => {
          if (!cancelled)
            setError({ scope, message: (error as Error).message });
        },
      )
      .finally(() => {
        if (!cancelled) setPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, revision, enabled]);
  return {
    value: result?.scope === scope ? result.value : undefined,
    fresh: result?.scope === scope && result.revision === revision,
    error: error?.scope === scope ? error.message : "",
    pending,
  };
}
