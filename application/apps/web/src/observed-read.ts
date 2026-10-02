/** Read authoritative state only after an invalidation (or an unsuccessful read).
 * A burst is coalesced, while a hint received during a read requests its tail.
 * This is a disposable UI observation, not a data or execution authority. */
export function createObservedRead<T>(options: {
  read: (signal: AbortSignal) => Promise<T>;
  publish: (value: T) => void;
  failed: (error: unknown) => void;
  schedule?: (
    callback: () => void,
    delay: number,
  ) => ReturnType<typeof setTimeout>;
  unschedule?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule ?? setTimeout;
  const unschedule = options.unschedule ?? clearTimeout;
  let closed = false,
    dirty = false,
    pending: Promise<boolean> | undefined,
    reading: AbortController | undefined,
    retry: ReturnType<typeof setTimeout> | undefined,
    delay = 1000;
  const clearRetry = () => {
    if (retry !== undefined) unschedule(retry);
    retry = undefined;
  };
  const request = (): Promise<boolean> => {
    if (closed) return Promise.resolve(false);
    clearRetry();
    dirty = true;
    // Invalidating a read cancels only that disposable query, never the task.
    reading?.abort();
    if (!pending)
      pending = Promise.resolve().then(async () => {
        let succeeded = false;
        try {
          do {
            dirty = false;
            reading = new AbortController();
            try {
              const value = await options.read(reading.signal);
              if (closed) return false;
              // A newer invalidation already exists. Do not briefly paint the
              // old result (or terminal status); publish the final tail read.
              if (!dirty) options.publish(value);
              succeeded = true;
              delay = 1000;
            } catch (error) {
              if (closed) return false;
              if (!dirty) options.failed(error);
              succeeded = false;
            } finally {
              reading = undefined;
            }
          } while (dirty && !closed);
          if (!succeeded && !closed) {
            retry = schedule(() => {
              retry = undefined;
              void request();
            }, delay);
            delay = Math.min(8000, delay * 2);
          }
          return succeeded;
        } finally {
          // Clear in this continuation. A later .finally can lose a hint in
          // the microtask between the dirty check and clearing the drain.
          pending = undefined;
        }
      });
    return pending;
  };
  return {
    request,
    close() {
      closed = true;
      dirty = false;
      reading?.abort();
      clearRetry();
    },
  };
}
