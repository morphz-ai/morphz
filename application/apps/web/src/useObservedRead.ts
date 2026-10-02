import { useEffect, useRef } from "react";
import { createObservedRead } from "./observed-read.js";

/** Shared workspace notifications already include authenticated Runtime wakes.
 * Each visible projection reads back its own authority, without another stream
 * or a healthy-state timer. Identity/scope changes dispose stale publication. */
export function useObservedRead<T>(options: {
  scope: string;
  enabled: boolean;
  revision: number;
  read: (signal: AbortSignal) => Promise<T>;
  publish: (value: T) => void;
  failed: (error: unknown) => void;
}) {
  const latest = useRef(options);
  latest.current = options;
  const observer = useRef<ReturnType<typeof createObservedRead<T>> | undefined>(
    undefined,
  );
  const revision = useRef(options.revision);
  useEffect(() => {
    revision.current = latest.current.revision;
    if (!options.enabled) return;
    const currentScope = () =>
      latest.current.scope === options.scope && latest.current.enabled;
    const current = createObservedRead({
      read: (signal) => {
        if (!currentScope())
          throw new DOMException("读取范围已变化。", "AbortError");
        return latest.current.read(signal);
      },
      // The render updates latest before passive cleanup. A response that
      // settles in that gap must not be published under the new scope.
      publish: (value: T) => {
        if (currentScope()) latest.current.publish(value);
      },
      failed: (error) => {
        if (currentScope()) latest.current.failed(error);
      },
    });
    observer.current = current;
    void current.request();
    return () => {
      current.close();
      if (observer.current === current) observer.current = undefined;
    };
  }, [options.scope, options.enabled]);
  useEffect(() => {
    if (revision.current === options.revision) return;
    revision.current = options.revision;
    void observer.current?.request();
  }, [options.revision]);
  return () => observer.current?.request() ?? Promise.resolve(false);
}
